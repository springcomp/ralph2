import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StagePlan, WorkflowPlan } from "../../src/config/compiler.js";
import { WorkflowEngine, type WorkflowEvent } from "../../src/core/engine.js";
import { WorkflowExitCodes } from "../../src/core/exit-codes.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../src/core/process-runner.js";
import { createExtensionRegistry } from "../../src/extensions/registry.js";
import type { TriggerRegistration } from "../../src/extensions/registry.js";

const createStagePlan = (overrides: Partial<StagePlan> = {}): StagePlan => ({
  name: "stage",
  executable: "echo",
  arguments: [],
  conditionalArguments: [],
  environment: [],
  timeoutMs: 5000,
  successExitCodes: [0],
  failurePolicy: "stop",
  ...overrides,
});

describe("WorkflowEngine triggers", () => {
  let tmpDir: string;
  let prdPath: string;
  let progressPath: string;
  let promptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-trigger-test-"));
    prdPath = join(tmpDir, "PRD.md");
    progressPath = join(tmpDir, "progress.txt");
    promptPath = join(tmpDir, "ralph.prompt.md");
    await writeFile(progressPath, "", "utf8");
    await writeFile(promptPath, "Do work", "utf8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const createPlan = (overrides: Partial<WorkflowPlan> = {}): WorkflowPlan => ({
    workspace: tmpDir,
    maxIterations: 5,
    maxRemediationAttempts: 2,
    statusFormat: "Iteration {ITERATION:000} - {TYP}-{NUM} - {TASK}",
    model: null,
    agent: null,
    defaultHarness: "pi",
    tasks: {
      prd: prdPath,
      progress: progressPath,
      prompt: promptPath,
      completionSignal: "<ralph>COMPLETE</ralph>",
    },
    harnesses: {
      pi: createStagePlan({ name: "pi", executable: "pi" }),
    },
    preAgent: [],
    postAgent: [],
    verification: { requireTaskChecked: true, retries: 0 },
    continuation: undefined,
    ...overrides,
  });

  it("completes normally when work is exhausted and no trigger is configured", async () => {
    await writeFile(prdPath, "", "utf8");
    const result = await new WorkflowEngine(new FakeProcessRunner()).run(
      createPlan(),
    );
    expect(result.status).toBe("complete");
    expect(result.exitCode).toBe(WorkflowExitCodes.Complete);
  });

  it("idles on exhaustion then resumes when the trigger fires", async () => {
    await writeFile(prdPath, "", "utf8");
    let fireCount = 0;
    const testTrigger: TriggerRegistration = {
      name: "testTrigger",
      description: "test",
      properties: [],
      callback: async () => {
        fireCount++;
        if (fireCount === 1) {
          await writeFile(prdPath, "- [ ] TASK-001 - Work\n", "utf8");
          return { reason: "task appeared" };
        }
        return null;
      },
    };
    const registry = createExtensionRegistry({ triggers: [testTrigger] });
    const events: WorkflowEvent[] = [];
    const runner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        await writeFile(prdPath, "- [x] TASK-001 - Work\n", "utf8");
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };
    const engine = new WorkflowEngine(
      runner,
      undefined,
      undefined,
      { onEvent: (e) => void events.push(e) },
      registry,
    );

    const result = await engine.run(
      createPlan({
        trigger: { kind: "testTrigger", source: prdPath, pollIntervalMs: 1 },
      }),
    );

    expect(result.status).toBe("complete");
    expect(fireCount).toBe(2);
    expect(runner.requests).toHaveLength(1);
    expect(events.some((e) => e.type === "trigger.waiting")).toBe(true);
    expect(events.some((e) => e.type === "trigger.fired")).toBe(true);
    expect(events.some((e) => e.type === "trigger.terminated")).toBe(true);
  });

  it("caps total iterations across wake-ups via maxIterations", async () => {
    await writeFile(prdPath, "", "utf8");
    let fireCount = 0;
    const alwaysFire: TriggerRegistration = {
      name: "alwaysFire",
      description: "test",
      properties: [],
      callback: async () => {
        fireCount++;
        return { reason: "fire" };
      },
    };
    const registry = createExtensionRegistry({ triggers: [alwaysFire] });
    const engine = new WorkflowEngine(
      new FakeProcessRunner(),
      undefined,
      undefined,
      {},
      registry,
    );
    const result = await engine.run(
      createPlan({
        maxIterations: 3,
        trigger: { kind: "alwaysFire", source: prdPath, pollIntervalMs: 1 },
      }),
    );
    expect(result.status).toBe("iterationLimit");
    expect(result.exitCode).toBe(WorkflowExitCodes.IterationLimitReached);
  });

  it("does not consult the trigger on a blocked remediation path", async () => {
    await writeFile(
      prdPath,
      [
        "- [x] TASK-001 - Original work",
        "- [x] BUILD-002 - Build failed for TASK-001 (parent: TASK-001)",
        "- [ ] BUILD-003 - Build failed for BUILD-002 (parent: BUILD-002)",
        "",
      ].join("\n"),
      "utf8",
    );
    let fireCount = 0;
    const spyTrigger: TriggerRegistration = {
      name: "spyTrigger",
      description: "test",
      properties: [],
      callback: async () => {
        fireCount++;
        return null;
      },
    };
    const registry = createExtensionRegistry({ triggers: [spyTrigger] });
    const plan = createPlan({
      trigger: { kind: "spyTrigger", source: prdPath, pollIntervalMs: 1 },
      postAgent: [
        createStagePlan({
          name: "build",
          failureTask:
            "- [ ] BUILD-{ITERATION:000} - Build failed for {TYP}-{NUM} (parent: {TYP}-{NUM})",
        }),
      ],
    });
    const runner = new FakeProcessRunner([
      { exitCode: 0, signal: null, timedOut: false, cancelled: false },
      { exitCode: 1, signal: null, timedOut: false, cancelled: false },
    ]);
    const result = await new WorkflowEngine(
      runner,
      undefined,
      undefined,
      {},
      registry,
    ).run(plan);

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Maximum remediation attempts (2)");
    expect(fireCount).toBe(0);
  });

  it("resumes via the built-in taskAppears trigger when a task appears", async () => {
    await writeFile(prdPath, "", "utf8");
    const registry = createExtensionRegistry();
    const runner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        await writeFile(prdPath, "- [x] TASK-001 - Work\n", "utf8");
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };
    const controller = new AbortController();
    const engine = new WorkflowEngine(
      runner,
      undefined,
      undefined,
      {},
      registry,
    );
    const runPromise = engine.run(
      createPlan({
        maxIterations: 10,
        trigger: { kind: "taskAppears", source: prdPath, pollIntervalMs: 10 },
      }),
      { signal: controller.signal },
    );
    // Let it idle, then drop in a task for the poller to discover.
    await new Promise((r) => setTimeout(r, 40));
    await writeFile(prdPath, "- [ ] TASK-001 - Work\n", "utf8");
    // After it drains and idles again, cancel to end the run.
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    const result = await runPromise;

    expect(runner.requests.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("canceled");
    expect(await readFile(prdPath, "utf8")).toContain("[x] TASK-001");
  });
});
