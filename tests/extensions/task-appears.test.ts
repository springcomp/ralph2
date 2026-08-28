import { describe, expect, it } from "vitest";
import type { Task, TaskDocumentReader } from "../../src/core/task.js";
import { taskAppearsTrigger } from "../../src/extensions/templates/blueprint/task-appears.js";
import type { TriggerContext } from "../../src/extensions/types.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const context = (
  observedSource: TaskDocumentReader,
  overrides: Partial<TriggerContext> = {},
): TriggerContext =>
  ({
    kind: "taskAppears",
    source: "queue.md",
    pollIntervalMs: 5,
    workspace: "/ws",
    taskSource: {} as never,
    observedSource,
    expand: (value: string) => value,
    emit: async () => undefined,
    ...overrides,
  }) as TriggerContext;

describe("taskAppearsTrigger", () => {
  it("fires immediately when an unchecked task is present", async () => {
    const signal = await taskAppearsTrigger.callback(
      context({ getFirstUncheckedTask: async () => task }),
    );
    expect(signal).toEqual({ reason: "Unchecked task TASK-001 appeared." });
  });

  it("returns null when aborted before any task appears", async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = await taskAppearsTrigger.callback(
      context(
        { getFirstUncheckedTask: async () => null },
        { signal: controller.signal },
      ),
    );
    expect(signal).toBeNull();
  });

  it("keeps polling past read errors until a task appears", async () => {
    let calls = 0;
    const observedSource: TaskDocumentReader = {
      getFirstUncheckedTask: async () => {
        calls++;
        if (calls === 1) throw new Error("transient read error");
        if (calls < 3) return null;
        return task;
      },
    };
    const signal = await taskAppearsTrigger.callback(context(observedSource));
    expect(signal).toEqual({ reason: "Unchecked task TASK-001 appeared." });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("resolves the delay early when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const observedSource: TaskDocumentReader = {
      getFirstUncheckedTask: async () => null,
    };
    const promise = taskAppearsTrigger.callback(
      context(observedSource, {
        pollIntervalMs: 10_000,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    const signal = await promise;
    expect(signal).toBeNull();
  });
});
