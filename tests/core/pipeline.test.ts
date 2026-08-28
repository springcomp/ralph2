import { describe, expect, it } from "vitest";
import { type PipelineContext, run } from "../../src/core/pipeline.js";
import type { Step, StepResult } from "../../src/core/plan.js";
import type { Task } from "../../src/core/task.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const step = (result: StepResult, policy: Step["onFail"]): Step => ({
  name: "work",
  role: "harness",
  onFail: policy,
  run: async () => result,
});

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
  workspace: "/ws",
  iteration: 1,
  task,
  ...overrides,
});

describe("pipeline run", () => {
  it("emits a stage.continued event and proceeds past a continue failure", async () => {
    const events: string[] = [];
    const outcome = await run(
      [step({ success: false }, { kind: "continue" })],
      ctx({
        emit: async (event) => {
          events.push(event.type);
        },
      }),
      1,
    );
    expect(outcome).toMatchObject({ terminal: false });
    expect(events).toEqual(["stage.continued"]);
  });

  it("reports a process timeout message on stop", async () => {
    const outcome = await run(
      [
        step(
          {
            success: false,
            process: {
              exitCode: null,
              signal: null,
              timedOut: true,
              cancelled: false,
            },
          },
          { kind: "stop" },
        ),
      ],
      ctx(),
      1,
    );
    expect(outcome).toMatchObject({
      terminal: true,
      status: "processFailure",
      message: "Process timed out.",
    });
  });

  it("reports an exit-code message on stop", async () => {
    const outcome = await run(
      [
        step(
          {
            success: false,
            process: {
              exitCode: 7,
              signal: null,
              timedOut: false,
              cancelled: false,
            },
          },
          { kind: "stop" },
        ),
      ],
      ctx(),
      1,
    );
    expect(outcome).toMatchObject({
      status: "processFailure",
      message: "Process exited with code 7.",
    });
  });

  it("prefers an explicit failure message", async () => {
    const outcome = await run(
      [step({ success: false, message: "boom" }, { kind: "stop" })],
      ctx(),
      1,
    );
    expect(outcome).toMatchObject({ message: "boom" });
  });

  it("marks a canceled outcome when the process was cancelled", async () => {
    const outcome = await run(
      [
        step(
          {
            success: false,
            process: {
              exitCode: null,
              signal: null,
              timedOut: false,
              cancelled: true,
            },
          },
          { kind: "stop" },
        ),
      ],
      ctx(),
      1,
    );
    expect(outcome).toMatchObject({
      terminal: true,
      status: "canceled",
      message: "Canceled.",
    });
  });

  it("marks a canceled outcome when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await run(
      [step({ success: false }, { kind: "stop" })],
      ctx({ signal: controller.signal }),
      1,
    );
    expect(outcome).toMatchObject({ status: "canceled" });
  });

  it("blocks when scheduling throws", async () => {
    const outcome = await run(
      [
        step(
          { success: false },
          { kind: "schedule", action: "fix", maxAttempts: 1 },
        ),
      ],
      ctx({
        schedule: async () => {
          throw new Error("scheduler down");
        },
      }),
      1,
    );
    expect(outcome).toMatchObject({
      terminal: true,
      status: "blocked",
      message: "Remediation scheduling failed: scheduler down",
    });
  });

  it("terminates the run as blocked when the action resolves to a run result", async () => {
    const terminal = {
      status: "blocked" as const,
      message: "exhausted",
      iterations: 1,
      events: [],
      exitCode: 3,
    };
    const outcome = await run(
      [
        step(
          { success: false },
          { kind: "schedule", action: "fix", maxAttempts: 1 },
        ),
      ],
      ctx({ schedule: async () => terminal }),
      1,
    );
    expect(outcome).toMatchObject({
      terminal: true,
      status: "blocked",
      message: "exhausted",
    });
  });
});
