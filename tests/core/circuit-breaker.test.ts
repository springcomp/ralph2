import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StagePlan, WorkflowPlan } from "../../src/config/compiler.js";
import {
  circuitBreakerStatePath,
  evaluateCircuitBreaker,
} from "../../src/core/circuit-breaker.js";
import { WorkflowEngine, type WorkflowEvent } from "../../src/core/engine.js";
import { WorkflowExitCodes } from "../../src/core/exit-codes.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../src/core/process-runner.js";
import { noProgressCircuitBreaker } from "../../src/extensions/circuit-breakers/no-progress.js";
import {
  type CircuitBreakerRegistration,
  createExtensionRegistry,
} from "../../src/extensions/registry.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

const run = promisify(execFile);

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

describe("evaluateCircuitBreaker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-cb-unit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resets the streak when the signature is null", async () => {
    await evaluateCircuitBreaker(tmpDir, "x", 3, "same");
    const result = await evaluateCircuitBreaker(tmpDir, "x", 3, null);
    expect(result).toEqual({ tripped: false, signature: null, streak: 0 });
  });

  it("increments the streak on a repeated signature", async () => {
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    const result = await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    expect(result).toEqual({ tripped: false, signature: "same", streak: 3 });
  });

  it("resets the streak to 1 when the signature changes", async () => {
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    const result = await evaluateCircuitBreaker(tmpDir, "x", 5, "different");
    expect(result).toEqual({
      tripped: false,
      signature: "different",
      streak: 1,
    });
  });

  it("trips once the streak reaches the threshold", async () => {
    await evaluateCircuitBreaker(tmpDir, "x", 3, "same");
    await evaluateCircuitBreaker(tmpDir, "x", 3, "same");
    const result = await evaluateCircuitBreaker(tmpDir, "x", 3, "same");
    expect(result).toEqual({ tripped: true, signature: "same", streak: 3 });
  });

  it("persists streak state across fresh calls (simulating a process restart)", async () => {
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    // Simulate a brand-new process by re-reading the persisted state file directly.
    const raw = JSON.parse(
      await readFile(circuitBreakerStatePath(tmpDir), "utf8"),
    );
    expect(raw.x).toEqual({ signature: "same", streak: 2 });
    const result = await evaluateCircuitBreaker(tmpDir, "x", 5, "same");
    expect(result.streak).toBe(3);
  });

  it("tracks multiple checks independently", async () => {
    await evaluateCircuitBreaker(tmpDir, "a", 3, "sig");
    await evaluateCircuitBreaker(tmpDir, "b", 3, "sig");
    const a = await evaluateCircuitBreaker(tmpDir, "a", 3, "sig");
    expect(a.streak).toBe(2);
    const b = await evaluateCircuitBreaker(tmpDir, "b", 3, "other");
    expect(b.streak).toBe(1);
  });
});

describe("noProgress circuit breaker check", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-cb-noprogress-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null (inactive) for a workspace with no recognized VCS", async () => {
    const signature = await noProgressCircuitBreaker.callback({
      kind: "noProgress",
      workspace: tmpDir,
      iteration: 1,
      expand: (v) => v,
    });
    expect(signature).toBeNull();
  });

  it("produces a stable signature for an unchanged git working tree and a new one after a commit", async () => {
    await run("git", ["init"], { cwd: tmpDir });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: tmpDir,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "a.txt"), "1", "utf8");
    await run("git", ["add", "."], { cwd: tmpDir });
    await run("git", ["commit", "-m", "initial"], { cwd: tmpDir });

    const context = {
      kind: "noProgress",
      workspace: tmpDir,
      iteration: 1,
      expand: (v: string) => v,
    };
    const first = await noProgressCircuitBreaker.callback(context);
    const second = await noProgressCircuitBreaker.callback(context);
    expect(first).not.toBeNull();
    expect(first).toBe(second);

    await writeFile(join(tmpDir, "a.txt"), "2", "utf8");
    await run("git", ["add", "."], { cwd: tmpDir });
    await run("git", ["commit", "-m", "second"], { cwd: tmpDir });
    const third = await noProgressCircuitBreaker.callback(context);
    expect(third).not.toBe(first);
  }, 15000);
});

describe("WorkflowEngine circuit breaker", () => {
  let tmpDir: string;
  let prdPath: string;
  let progressPath: string;
  let promptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-cb-engine-test-"));
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
    maxIterations: 10,
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

  it("does nothing when circuitBreaker is not configured (regression)", async () => {
    await writeFile(prdPath, "- [x] TASK-001 - Work\n", "utf8");
    const result = await new WorkflowEngine(
      new FakeProcessRunner(),
      new MarkdownTaskSource(),
    ).run(createPlan());
    expect(result.status).toBe("complete");
  });

  it("trips blocked after a non-mandatory gate fails the same way every iteration", async () => {
    const gate: CircuitBreakerRegistration = {
      name: "alwaysFails",
      description: "test",
      properties: [],
      callback: async ({ lastFailure }) =>
        lastFailure ? `${lastFailure.stage}:${lastFailure.exitCode}` : null,
    };
    const registry = createExtensionRegistry({ circuitBreakers: [gate] });
    await writeFile(
      prdPath,
      "- [ ] TASK-001 - Work\n- [ ] TASK-002 - Work\n- [ ] TASK-003 - Work\n- [ ] TASK-004 - Work\n",
      "utf8",
    );
    const plan = createPlan({
      maxIterations: 10,
      circuitBreaker: { checks: [{ kind: "alwaysFails", threshold: 3 }] },
      verification: { requireTaskChecked: false, retries: 0 },
      postAgent: [
        createStagePlan({
          name: "lint",
          mandatory: false,
          failurePolicy: "continue",
        }),
      ],
    });
    const runner = new FakeProcessRunner([
      { exitCode: 0, signal: null, timedOut: false, cancelled: false }, // harness (iter 1)
      { exitCode: 1, signal: null, timedOut: false, cancelled: false }, // lint fails (iter 1)
      { exitCode: 0, signal: null, timedOut: false, cancelled: false }, // harness (iter 2)
      { exitCode: 1, signal: null, timedOut: false, cancelled: false }, // lint fails (iter 2)
      { exitCode: 0, signal: null, timedOut: false, cancelled: false }, // harness (iter 3)
      { exitCode: 1, signal: null, timedOut: false, cancelled: false }, // lint fails (iter 3)
    ]);
    const events: WorkflowEvent[] = [];
    const result = await new WorkflowEngine(
      runner,
      new MarkdownTaskSource(),
      undefined,
      { onEvent: (e) => void events.push(e) },
      registry,
    ).run(plan);

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(WorkflowExitCodes.Blocked);
    expect(result.message).toContain("alwaysFails");
    expect(events.map(({ type }) => type)).toEqual([
      "task.started",
      "stage.started",
      "stage.completed",
      "stage.started",
      "stage.completed",
      "stage.continued",
      "circuitBreaker.streak",
      "task.started",
      "stage.started",
      "stage.completed",
      "stage.started",
      "stage.completed",
      "stage.continued",
      "circuitBreaker.streak",
      "task.started",
      "stage.started",
      "stage.completed",
      "stage.started",
      "stage.completed",
      "stage.continued",
      "circuitBreaker.tripped",
    ]);
  });

  it("does not trip when the failure signature changes across iterations", async () => {
    let call = 0;
    const gate: CircuitBreakerRegistration = {
      name: "changingFailure",
      description: "test",
      properties: [],
      callback: async ({ lastFailure }) => {
        if (!lastFailure) return null;
        call++;
        return `${lastFailure.stage}:${call}`;
      },
    };
    const registry = createExtensionRegistry({ circuitBreakers: [gate] });
    await writeFile(
      prdPath,
      "- [ ] TASK-001 - Work\n- [ ] TASK-002 - Work\n- [ ] TASK-003 - Work\n",
      "utf8",
    );
    const plan = createPlan({
      maxIterations: 5,
      circuitBreaker: { checks: [{ kind: "changingFailure", threshold: 2 }] },
      postAgent: [
        createStagePlan({
          name: "lint",
          executable: "lint-tool",
          mandatory: false,
          failurePolicy: "continue",
        }),
      ],
    });
    // A custom runner that checks off the current task on the harness call
    // (so each iteration advances to the next task) and fails the lint stage
    // every time, but its signature-producing check varies per-call, so the
    // streak should never reach the threshold.
    let lintCalls = 0;
    const runner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        if (req.command === "lint-tool") {
          lintCalls++;
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        const content = await readFile(prdPath, "utf8");
        const lines = content.split("\n");
        const index = lines.findIndex((line) => line.includes("- [ ]"));
        if (index >= 0) lines[index] = lines[index].replace("- [ ]", "- [x]");
        await writeFile(prdPath, lines.join("\n"), "utf8");
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };
    const result = await new WorkflowEngine(
      runner,
      new MarkdownTaskSource(),
      undefined,
      {},
      registry,
    ).run(plan);

    expect(result.status).toBe("complete");
    expect(lintCalls).toBe(3);
  });
});
