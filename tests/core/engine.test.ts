import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StagePlan, WorkflowPlan } from "../../src/config/compiler.js";
import { WorkflowEngine, type WorkflowEvent } from "../../src/core/engine.js";
import { WorkflowExitCodes } from "../../src/core/exit-codes.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import { WorkspaceLock } from "../../src/core/locks.js";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../src/core/process-runner.js";

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

describe("WorkflowEngine", () => {
  let tmpDir: string;
  let prdPath: string;
  let progressPath: string;
  let promptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-engine-test-"));
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
    statusFormat:
      "Iteration {ITERATION:000} - {TYP}-{NUM} - {TASK} (model: `{MODEL}`)",
    model: "yaml-model",
    agent: "yaml-agent",
    defaultHarness: "pi",
    tasks: {
      prd: prdPath,
      progress: progressPath,
      prompt: promptPath,
      completionSignal: "<ralph>COMPLETE</ralph>",
    },
    harnesses: {
      pi: createStagePlan({
        name: "pi",
        executable: "pi",
        arguments: ["--model", "{MODEL}", "--prompt", "{PROMPT}"],
        environment: [{ name: "SECRET_KEY", value: "secret123", secret: true }],
      }),
    },
    preAgent: [],
    postAgent: [],
    verification: {
      requireTaskChecked: true,
      retries: 1,
      prompt: "Verify task: {TASK}",
    },
    continuation: undefined,
    ...overrides,
  });

  it("completes successfully when task is checked off by harness", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Implement feature\n", "utf8");
    const runner = new FakeProcessRunner();
    const statuses: string[] = [];
    const events: WorkflowEvent[] = [];

    const customRunner = {
      requests: runner.requests,
      async run(req: ProcessRequest): Promise<ProcessResult> {
        runner.requests.push(req);
        await writeFile(
          prdPath,
          "- [x] TASK-001 - Implement feature\n",
          "utf8",
        );
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const engine = new WorkflowEngine(customRunner, undefined, undefined, {
      onStatus: (s) => {
        statuses.push(s);
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    const result = await engine.run(createPlan());

    expect(result.status).toBe("complete");
    expect(result.exitCode).toBe(WorkflowExitCodes.Complete);
    expect(statuses).toEqual([
      "Iteration 001 - TASK-001 - Implement feature (model: `yaml-model`)",
    ]);
    expect(events.some((e) => e.type === "task.started")).toBe(true);
  });

  it("handles model and agent precedence: Task Metadata > CLI > YAML Default", async () => {
    await writeFile(
      prdPath,
      "- [ ] TASK-001 - Custom metadata (model: `meta-model`) (agent: `meta-agent`)\n",
      "utf8",
    );
    const runner = new FakeProcessRunner();
    const customRunner = {
      requests: runner.requests,
      async run(req: ProcessRequest): Promise<ProcessResult> {
        runner.requests.push(req);
        await writeFile(
          prdPath,
          "- [x] TASK-001 - Custom metadata (model: `meta-model`) (agent: `meta-agent`)\n",
          "utf8",
        );
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(createPlan(), {
      model: "cli-model",
      agent: "cli-agent",
    });

    expect(result.status).toBe("complete");
    expect(customRunner.requests[0].args).toContain("meta-model");
  });

  it("uses default marker (default) when no model configured", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - No model task\n", "utf8");
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        await writeFile(prdPath, "- [x] TASK-001 - No model task\n", "utf8");
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const statuses: string[] = [];
    const engine = new WorkflowEngine(customRunner, undefined, undefined, {
      onStatus: (s) => {
        statuses.push(s);
      },
    });
    const plan = createPlan({ model: null });
    await engine.run(plan, { model: null });

    expect(statuses[0]).toContain("(default)");
  });

  it("returns blocked when workspace lock is already acquired", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Locked\n", "utf8");
    const lock = new WorkspaceLock(tmpDir);
    await lock.acquire();

    try {
      const engine = new WorkflowEngine(new FakeProcessRunner());
      const result = await engine.run(createPlan());

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(WorkflowExitCodes.Blocked);
    } finally {
      await lock.release();
    }
  });

  it("fails with blocked status when unconfigured harness is requested", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Test task\n", "utf8");
    const engine = new WorkflowEngine(new FakeProcessRunner());
    const result = await engine.run(createPlan(), { harness: "nonexistent" });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(WorkflowExitCodes.Blocked);
    expect(result.message).toContain(
      "Harness 'nonexistent' is not configured.",
    );
  });

  it("schedules failure task on preAgent stage failure and continues loop", async () => {
    // When a failureTask is configured, scheduling it must let the loop
    // continue regardless of failurePolicy so the scheduled task is processed.
    await writeFile(prdPath, "- [ ] TASK-001 - Initial task\n", "utf8");
    const runner = new FakeProcessRunner([
      { exitCode: 1, signal: null, timedOut: false, cancelled: false },
    ]);

    const plan = createPlan({
      preAgent: [
        createStagePlan({
          name: "pre-check",
          executable: "check",
          failurePolicy: "stop",
          failureTask: "- [ ] FIX-{ITERATION:000} - Pre-check failed",
        }),
      ],
    });

    const engine = new WorkflowEngine(runner);
    const result = await engine.run(plan);

    // Loop must NOT stop with processFailure — it continues until limit.
    expect(result.status).not.toBe("processFailure");

    const prdContent = await readFile(prdPath, "utf8");
    expect(prdContent).toContain("FIX-001 - Pre-check failed");
  });

  it("stops with processFailure on preAgent stage failure with stop policy and no failureTask", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Initial task\n", "utf8");
    const runner = new FakeProcessRunner([
      { exitCode: 1, signal: null, timedOut: false, cancelled: false },
    ]);

    const plan = createPlan({
      preAgent: [
        createStagePlan({
          name: "pre-check",
          executable: "check",
          failurePolicy: "stop",
        }),
      ],
    });

    const engine = new WorkflowEngine(runner);
    const result = await engine.run(plan);

    expect(result.status).toBe("processFailure");
    expect(result.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
  });

  it("handles preAgent stage completing and emptying PRD", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Pre checked task\n", "utf8");
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        if (req.command === "precheck") {
          await writeFile(
            prdPath,
            "- [x] TASK-001 - Pre checked task\n",
            "utf8",
          );
        }
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      preAgent: [
        createStagePlan({
          name: "pre-check",
          executable: "precheck",
        }),
      ],
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
  });

  it("handles harness process failure", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Failing harness\n", "utf8");
    const runner = new FakeProcessRunner([
      { exitCode: 127, signal: null, timedOut: false, cancelled: false },
    ]);

    const engine = new WorkflowEngine(runner);
    const result = await engine.run(createPlan());

    expect(result.status).toBe("processFailure");
    expect(result.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
  });

  it("handles postAgent stage failure with stop policy", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Post fail\n", "utf8");
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        if (req.command === "pi") {
          await writeFile(prdPath, "- [x] TASK-001 - Post fail\n", "utf8");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        return { exitCode: 1, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      postAgent: [
        createStagePlan({
          name: "lint",
          executable: "lint",
          failurePolicy: "stop",
        }),
      ],
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("processFailure");
  });

  it("handles postAgent stage failure with continue policy and schedules task", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Feature work\n", "utf8");

    let harnessCallCount = 0;
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        if (req.command === "pi") {
          harnessCallCount++;
          if (harnessCallCount === 1) {
            await writeFile(prdPath, "- [x] TASK-001 - Feature work\n", "utf8");
          } else {
            await writeFile(
              prdPath,
              "- [x] TASK-001 - Feature work\n- [x] FIX-001 - Build failed\n",
              "utf8",
            );
          }
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        if (req.command === "npm" && harnessCallCount === 1) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      maxIterations: 3,
      postAgent: [
        createStagePlan({
          name: "build",
          executable: "npm",
          arguments: ["run", "build"],
          failurePolicy: "continue",
          failureTask: "- [ ] FIX-{ITERATION:000} - Build failed",
        }),
      ],
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
    expect(harnessCallCount).toBe(2);
  });

  it("runs verification loop when task remains unchecked", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Unchecked task\n", "utf8");
    let harnessInvocations = 0;

    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        harnessInvocations++;
        if (harnessInvocations === 2) {
          await writeFile(prdPath, "- [x] TASK-001 - Unchecked task\n", "utf8");
        }
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      verification: {
        requireTaskChecked: true,
        retries: 2,
        prompt: "Please verify: {TASK}",
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
    expect(harnessInvocations).toBe(2);
  });

  it("returns blocked when task remains unchecked after all verification retries", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Stubborn task\n", "utf8");
    const runner = new FakeProcessRunner();

    const plan = createPlan({
      verification: {
        requireTaskChecked: true,
        retries: 1,
        prompt: "Please verify: {TASK}",
      },
    });

    const engine = new WorkflowEngine(runner);
    const result = await engine.run(plan);

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(WorkflowExitCodes.Blocked);
    expect(result.message).toContain("remained unchecked after verification");
  });

  it("handles verification retry failure when harness process crashes", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Task\n", "utf8");
    let count = 0;
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        count++;
        if (count === 1) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        return { exitCode: 1, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      verification: {
        requireTaskChecked: true,
        retries: 1,
        prompt: "Check",
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("processFailure");
  });

  it("handles blueprint continuation and marks blueprint task checked", async () => {
    const blueprintPath = join(tmpDir, "BLUEPRINT.md");
    await writeFile(
      blueprintPath,
      "# Blueprint\n- [ ] BP-001 - Blueprint step 1\n",
      "utf8",
    );
    await writeFile(prdPath, "# PRD\n", "utf8");

    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        await writeFile(
          prdPath,
          "# PRD\n- [x] BP-001 - Blueprint step 1\n",
          "utf8",
        );
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      continuation: {
        kind: "blueprint",
        source: blueprintPath,
        seedPrdFromSource: true,
        completeWhenSourceExhausted: true,
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
    const bpContent = await readFile(blueprintPath, "utf8");
    expect(bpContent).toContain("- [x] BP-001 - Blueprint step 1");
  });

  it("handles blueprint continuation when completeWhenSourceExhausted is false", async () => {
    const blueprintPath = join(tmpDir, "BLUEPRINT.md");
    await writeFile(blueprintPath, "# Blueprint\n", "utf8");
    await writeFile(prdPath, "# PRD\n", "utf8");

    const plan = createPlan({
      continuation: {
        kind: "blueprint",
        source: blueprintPath,
        seedPrdFromSource: true,
        completeWhenSourceExhausted: false,
      },
    });

    const engine = new WorkflowEngine(new FakeProcessRunner());
    const result = await engine.run(plan);

    expect(result.status).toBe("blocked");
    expect(result.message).toBe("Blueprint source exhausted.");
  });

  it("handles generatedGoal continuation until completeWhen fileMissing predicate matches", async () => {
    const flagFile = join(tmpDir, "stop.flag");
    await writeFile(flagFile, "present", "utf8");
    await writeFile(prdPath, "- [ ] GOAL-001 - Initial goal step\n", "utf8");

    let goalIteration = 0;
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        if (req.command === "pi") {
          goalIteration++;
          await writeFile(
            prdPath,
            `- [x] GOAL-${goalIteration.toString().padStart(3, "0")} - Step\n`,
            "utf8",
          );
        }
        if (req.command === "producer") {
          if (goalIteration >= 2) {
            await rm(flagFile, { force: true });
          }
        }
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      maxIterations: 5,
      continuation: {
        kind: "generatedGoal",
        seedPrdFromSource: false,
        completeWhenSourceExhausted: false,
        producer: createStagePlan({
          name: "producer",
          executable: "producer",
        }),
        completeWhen: {
          kind: "fileMissing",
          path: flagFile,
        },
        nextTask: "- [ ] GOAL-{ITERATION:000} - Next generated task",
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
    expect(result.message).toBe("Completion predicate matched.");
  });

  it("handles generatedGoal continuation until completeWhen acceptedExitCode predicate matches", async () => {
    await writeFile(prdPath, "- [ ] GOAL-001 - Initial goal step\n", "utf8");

    let goalIteration = 0;
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        this.requests.push(req);
        if (req.command === "pi") {
          goalIteration++;
          await writeFile(
            prdPath,
            `- [x] GOAL-${goalIteration.toString().padStart(3, "0")} - Step\n`,
            "utf8",
          );
        }
        if (req.command === "check") {
          return goalIteration >= 2
            ? { exitCode: 0, signal: null, timedOut: false, cancelled: false }
            : { exitCode: 1, signal: null, timedOut: false, cancelled: false };
        }
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      maxIterations: 5,
      continuation: {
        kind: "generatedGoal",
        seedPrdFromSource: false,
        completeWhenSourceExhausted: false,
        producer: createStagePlan({
          name: "producer",
          executable: "producer",
        }),
        completeWhen: {
          kind: "acceptedExitCode",
          check: createStagePlan({
            name: "check",
            executable: "check",
          }),
        },
        nextTask: "- [ ] GOAL-{ITERATION:000} - Next generated task",
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("complete");
    expect(result.message).toBe("Completion predicate matched.");
  });

  it("handles producer failure in generatedGoal continuation", async () => {
    await writeFile(prdPath, "- [ ] GOAL-001 - Step\n", "utf8");
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        if (req.command === "pi") {
          await writeFile(prdPath, "- [x] GOAL-001 - Step\n", "utf8");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
          };
        }
        return { exitCode: 1, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      continuation: {
        kind: "generatedGoal",
        seedPrdFromSource: false,
        completeWhenSourceExhausted: false,
        producer: createStagePlan({
          name: "producer",
          executable: "producer",
        }),
        completeWhen: { kind: "fileExists", path: "nonexistent" },
        nextTask: "- [ ] GOAL-NEXT",
      },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("processFailure");
  });

  it("handles iteration limit reached", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Neverending\n", "utf8");
    let iterations = 0;
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        iterations++;
        await writeFile(
          prdPath,
          `- [x] TASK-001 - Neverending\n- [ ] TASK-${(iterations + 1).toString().padStart(3, "0")} - Neverending\n`,
          "utf8",
        );
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const plan = createPlan({
      maxIterations: 2,
      verification: { requireTaskChecked: false, retries: 0 },
    });

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.run(plan);

    expect(result.status).toBe("iterationLimit");
    expect(result.exitCode).toBe(WorkflowExitCodes.IterationLimitReached);
  });

  it("handles cancellation via AbortSignal", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Aborted\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    const engine = new WorkflowEngine(new FakeProcessRunner());
    const result = await engine.run(createPlan(), {
      signal: controller.signal,
    });

    expect(result.status).toBe("canceled");
    expect(result.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
  });

  it("handles runAsync alias", async () => {
    await writeFile(prdPath, "- [ ] TASK-001 - Feature\n", "utf8");
    const customRunner = {
      requests: [] as ProcessRequest[],
      async run(req: ProcessRequest): Promise<ProcessResult> {
        await writeFile(prdPath, "- [x] TASK-001 - Feature\n", "utf8");
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      },
    };

    const engine = new WorkflowEngine(customRunner);
    const result = await engine.runAsync(createPlan());
    expect(result.status).toBe("complete");
  });
});
