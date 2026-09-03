import { describe, expect, it } from "vitest";
import type { StagePlan } from "../../src/config/compiler.js";
import type { ProcessResult } from "../../src/core/process-runner.js";
import type { TaskSource } from "../../src/core/task.js";
import { scheduleTaskAction } from "../../src/extensions/templates/blueprint/schedule-task-action.js";
import type { PlaceholderContext } from "../../src/placeholders/placeholders.js";

describe("scheduleTask action", () => {
  it("schedules the expanded failure task and emits an event", async () => {
    const scheduled: string[] = [];
    const emitted: unknown[] = [];
    await scheduleTaskAction.callback({
      source: {
        scheduleTask: async (task: string): Promise<void> => {
          scheduled.push(task);
        },
      } as TaskSource,
      stage: { name: "build", failureTask: "FIX-{ITERATION}" } as StagePlan,
      values: { iteration: 3 } as PlaceholderContext,
      result: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
      } as ProcessResult,
      iteration: 3,
      expand: (value) => value.replace("{ITERATION}", "003"),
      emit: async (event) => {
        emitted.push(event);
      },
    });
    expect(scheduled).toEqual(["FIX-003"]);
    expect(emitted).toHaveLength(1);
  });

  it("uses an empty task when no failure task is configured", async () => {
    let scheduled = "";
    await scheduleTaskAction.callback({
      source: {
        scheduleTask: async (task: string): Promise<void> => {
          scheduled = task;
        },
      } as TaskSource,
      stage: { name: "build" } as StagePlan,
      values: { iteration: 1 } as PlaceholderContext,
      result: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
      } as ProcessResult,
      iteration: 1,
      expand: (value) => value,
      emit: async () => {},
    });
    expect(scheduled).toBe("");
  });
});
