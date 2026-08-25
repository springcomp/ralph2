import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { taskAppearsTrigger } from "../../src/extensions/triggers/task-appears.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

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
    const result = await new WorkflowEngine(
      new FakeProcessRunner(),
      new MarkdownTaskSource(),
    ).run(createPlan());
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
      new MarkdownTaskSource(),
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
    expect(events.map(({ type }) => type)).toEqual([
      "trigger.waiting",
      "trigger.fired",
      "task.started",
      "stage.started",
      "stage.completed",
      "trigger.waiting",
      "trigger.terminated",
    ]);
  });

  it("returns canceled after entering trigger idle and being aborted", async () => {
    await writeFile(prdPath, "", "utf8");
    const controller = new AbortController();
    const trigger: TriggerRegistration = {
      name: "abortable",
      description: "test",
      properties: [],
      callback: async ({ signal }) => {
        callbackResolve?.();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(null);
            },
            { once: true },
          );
        });
      },
    };
    const events: WorkflowEvent[] = [];
    let callbackResolve: (() => void) | undefined;
    const callbackStarted = new Promise<void>((resolve) => {
      callbackResolve = resolve;
    });
    const engine = new WorkflowEngine(
      new FakeProcessRunner(),
      new MarkdownTaskSource(),
      undefined,
      { onEvent: (event) => void events.push(event) },
      createExtensionRegistry({ triggers: [trigger] }),
    );
    const runPromise = engine.run(
      createPlan({
        trigger: { kind: "abortable", source: prdPath, pollIntervalMs: 1 },
      }),
      { signal: controller.signal },
    );

    await callbackStarted;
    controller.abort();
    const result = await runPromise;

    expect(result.status).toBe("canceled");
    expect(result.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
    expect(events.map(({ type }) => type)).toEqual(["trigger.waiting"]);
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
      new MarkdownTaskSource(),
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
      new MarkdownTaskSource(),
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
      new MarkdownTaskSource(),
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
    await writeFile(prdPath, "- [ ] TASK-001 - Work\n", "utf8");
    await vi.waitFor(() => expect(runner.requests).toHaveLength(1), {
      timeout: 2000,
    });
    controller.abort();
    const result = await runPromise;

    expect(runner.requests.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("canceled");
    expect(await readFile(prdPath, "utf8")).toContain("[x] TASK-001");
  });

  it("fires the built-in trigger for an already available task", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Work\n", "utf8");

    const signal = await taskAppearsTrigger.callback({
      kind: "taskAppears",
      source: prdPath,
      pollIntervalMs: 1,
      workspace: tmpDir,
      taskSource: new MarkdownTaskSource(),
      expand: (value) => value,
      emit: async () => {},
    });

    expect(signal).toEqual({ reason: "Unchecked task TASK-001 appeared." });
  });

  it("returns null when polling is aborted after a source failure", async () => {
    const controller = new AbortController();
    let callbackStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const taskSource = new MarkdownTaskSource();
    vi.spyOn(taskSource, "getFirstUncheckedTask").mockImplementation(
      async () => {
        callbackStarted?.();
        throw new Error("source unavailable");
      },
    );

    const callback = taskAppearsTrigger.callback({
      kind: "taskAppears",
      source: prdPath,
      pollIntervalMs: 1000,
      workspace: tmpDir,
      taskSource,
      expand: (value) => value,
      emit: async () => {},
      signal: controller.signal,
    });

    await started;
    controller.abort();

    await expect(callback).resolves.toBeNull();
  });

  it("returns null immediately when polling starts already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const signal = await taskAppearsTrigger.callback({
      kind: "taskAppears",
      source: prdPath,
      pollIntervalMs: 1000,
      workspace: tmpDir,
      taskSource: new MarkdownTaskSource(),
      expand: (value) => value,
      emit: async () => {},
      signal: controller.signal,
    });

    expect(signal).toBeNull();
  });
});
