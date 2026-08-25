import { describe, expect, it } from "vitest";
import type {
  CoreContext,
  CorePlan,
  Guard,
  Outcome,
  Policy,
  Predicate,
  Step,
  StepResult,
  WorkSource,
} from "../../src/core/plan.js";
import type { Task } from "../../src/core/task.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Implement feature",
  rawLine: "- [ ] TASK-001 - Implement feature",
  lineIndex: 0,
};

const context: CoreContext = {
  workspace: "/workspace",
  iteration: 1,
  task,
};

describe("core plan vocabulary", () => {
  it("constructs each core interface and policy", async () => {
    const result: StepResult = { success: true };
    const predicate: Predicate = { check: async () => true };
    const policies: Policy[] = [
      { kind: "stop" },
      { kind: "continue" },
      { kind: "retry", predicate, times: 2 },
      { kind: "schedule", action: "scheduleTask", maxAttempts: 3 },
    ];
    const step: Step = {
      name: "build",
      role: "harness",
      onFail: policies[0],
      run: async () => result,
    };
    const source: WorkSource = {
      pull: async () => task,
      afterTask: async () => undefined,
    };
    const guard: Guard = {
      kind: "noProgress",
      threshold: 2,
      signature: async () => "signature",
    };
    const outcomes: Outcome[] = [
      { terminal: false, lastFailure: null, scheduled: false },
      { terminal: true, status: "processFailure", message: "failed" },
    ];
    const plan: CorePlan = {
      workspace: context.workspace,
      maxIterations: 5,
      source,
      steps: [step],
      guards: [guard],
      status: () => "TASK-001",
    };

    expect(await step.run(context)).toBe(result);
    expect(await predicate.check(context)).toBe(true);
    expect(await source.pull(1)).toBe(task);
    expect(await guard.signature(context)).toBe("signature");
    expect(plan.steps).toContain(step);
    expect(outcomes).toHaveLength(2);
  });
});
