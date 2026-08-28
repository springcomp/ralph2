import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/engine-core.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import type { CorePlan, Step } from "../../src/core/plan.js";
import type { Task, TaskSource } from "../../src/core/task.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const source = (overrides: Partial<TaskSource> = {}): TaskSource => ({
  getFirstUncheckedTask: async () => null,
  remediationDepth: async () => ({ depth: 0, rootId: task.id }),
  isTaskUnchecked: async () => false,
  checkTask: async () => undefined,
  scheduleTask: async () => undefined,
  seedBlueprintTask: async () => null,
  ...overrides,
});

const stage = {
  name: "work",
  failureTask: "FIX-001 - repair",
  command: { run: "echo" },
} as never;

const failingStep = (
  policy: Step["onFail"],
  withStage = true,
  withProcess = true,
): Step => ({
  name: "work",
  role: "harness",
  onFail: policy,
  stage: withStage ? stage : undefined,
  run: async () =>
    withProcess
      ? {
          success: false,
          process: {
            exitCode: 1,
            signal: null,
            timedOut: false,
            cancelled: false,
          },
        }
      : { success: false },
});

const runEngine = async (
  taskSource: TaskSource,
  step: Step,
): Promise<{ status: string; message: string; events: string[] }> => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-sched-"));
  try {
    const plan: CorePlan = {
      workspace,
      maxIterations: 1,
      source: { ...taskSource, pull: async () => task },
      steps: [step],
      guards: [],
      status: () => "working",
    };
    const result = await new CoreEngine(
      new FakeProcessRunner(),
      taskSource,
    ).run(plan);
    return {
      status: result.status,
      message: result.message,
      events: result.events.map((event) => event.type),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

describe("CoreEngine scheduling failures", () => {
  it("blocks when the scheduled action is not registered", async () => {
    const result = await runEngine(
      source(),
      failingStep({
        kind: "schedule",
        action: "notARealAction",
        maxAttempts: 1,
      }),
    );
    expect(result).toMatchObject({
      status: "blocked",
      message: "Action 'notARealAction' is not registered.",
    });
  });

  it("blocks when a scheduled failure has no stage", async () => {
    const result = await runEngine(
      source(),
      failingStep(
        { kind: "schedule", action: "scheduleTask", maxAttempts: 1 },
        false,
      ),
    );
    expect(result).toMatchObject({
      status: "blocked",
      message: "Scheduled failure has no stage.",
    });
  });

  it("schedules a staged failure that carries no process result", async () => {
    const scheduled: string[] = [];
    const result = await runEngine(
      source({
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      }),
      failingStep(
        { kind: "schedule", action: "scheduleTask", maxAttempts: 1 },
        true,
        false,
      ),
    );
    expect(result.events).toContain("fix.scheduled");
    expect(scheduled).toEqual(["FIX-001 - repair"]);
  });

  it("blocks and emits when remediation attempts are exhausted", async () => {
    const result = await runEngine(
      source({
        remediationDepth: async () => ({ depth: 3, rootId: "TASK-001" }),
      }),
      failingStep({ kind: "schedule", action: "scheduleTask", maxAttempts: 2 }),
    );
    expect(result.status).toBe("blocked");
    expect(result.message).toContain(
      "Maximum remediation attempts (2) reached for TASK-001",
    );
    expect(result.events).toContain("remediation.exhausted");
  });
});
