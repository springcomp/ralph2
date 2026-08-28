import { describe, expect, it, vi } from "vitest";
import {
  BlueprintRefill,
  ChainedWorkSource,
  GeneratorWorkSource,
  PrdSource,
  TriggerWorkSource,
} from "../../src/config/lowering/worksource.js";
import type { CoreContext } from "../../src/core/plan.js";
import type { WorkSource } from "../../src/core/plan.js";
import type { Task, TaskSource } from "../../src/core/task.js";
import type { ExtensionRegistry } from "../../src/extensions/registry.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const fakeSource = (overrides: Partial<TaskSource> = {}): TaskSource => ({
  getFirstUncheckedTask: async () => null,
  remediationDepth: async () => ({ depth: 0, rootId: task.id }),
  isTaskUnchecked: async () => false,
  checkTask: async () => undefined,
  scheduleTask: async () => undefined,
  seedBlueprintTask: async () => null,
  ...overrides,
});

const producerStage = { name: "produce", command: { run: "echo" } } as never;

describe("PrdSource", () => {
  it("pulls the first unchecked task", async () => {
    const src = new PrdSource(
      fakeSource({ getFirstUncheckedTask: async () => task }),
    );
    expect(await src.pull()).toBe(task);
  });
});

describe("BlueprintRefill", () => {
  it("seeds the blueprint before pulling", async () => {
    const seeded: string[] = [];
    const src = new BlueprintRefill(
      fakeSource({
        seedBlueprintTask: async (path: string) => {
          seeded.push(path);
          return null;
        },
        getFirstUncheckedTask: async () => task,
      }),
      "blueprint.md",
    );
    expect(await src.pull()).toBe(task);
    expect(seeded).toEqual(["blueprint.md"]);
  });

  it("prefers a legacy blueprint path when provided", async () => {
    const seeded: string[] = [];
    const src = new BlueprintRefill(
      fakeSource({
        seedBlueprintTask: async (path: string) => {
          seeded.push(path);
          return null;
        },
      }),
      "new.md",
      "legacy.md",
    );
    await src.pull();
    expect(seeded).toEqual(["legacy.md"]);
  });
});

describe("ChainedWorkSource", () => {
  it("advances through sources and resets its cursor", async () => {
    const first = { pull: vi.fn(async () => null) };
    const second = { pull: vi.fn(async () => task) };
    const chain = new ChainedWorkSource([first, second]);
    expect(await chain.pull(1)).toBe(task);
    expect(first.pull).toHaveBeenCalledTimes(1);

    // Cursor stayed at the second source; reset rewinds it.
    chain.reset();
    first.pull.mockResolvedValueOnce(task);
    expect(await chain.pull(2)).toBe(task);
    expect(first.pull).toHaveBeenCalledTimes(2);
  });

  it("returns null and exposes the configured completion status when exhausted", async () => {
    const chain = new ChainedWorkSource(
      [{ pull: async () => null }],
      "blocked",
      "nothing left",
    );
    expect(await chain.pull(1)).toBeNull();
    expect(chain.completionStatus).toBe("blocked");
    expect(chain.blockedMessage).toBe("nothing left");
  });

  it("defaults completion status to complete", () => {
    const chain = new ChainedWorkSource([]);
    expect(chain.completionStatus).toBe("complete");
  });
});

describe("GeneratorWorkSource", () => {
  const makeCtx = (
    runStage: (
      stage: unknown,
      ctx: CoreContext,
    ) => Promise<{ success: boolean }>,
  ): CoreContext =>
    ({
      workspace: "/ws",
      iteration: 1,
      task,
      runStage,
      expand: (value: string) => value,
    }) as never;

  it("seeds the initial task on the first empty pull", async () => {
    const scheduled: string[] = [];
    const base = { pull: vi.fn(async () => null) };
    const src = new GeneratorWorkSource(
      base,
      producerStage,
      { kind: "fileExists", path: "done" },
      "NEXT - continue",
      fakeSource({
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      }),
      {} as never,
      defaultExtensionRegistry,
      "SEED - start",
    );
    base.pull.mockResolvedValueOnce(null).mockResolvedValueOnce(task);
    expect(await src.pull(1)).toBe(task);
    expect(scheduled).toEqual(["SEED - start"]);
  });

  it("does not seed when a task is already present", async () => {
    const scheduled: string[] = [];
    const base = { pull: async () => task };
    const src = new GeneratorWorkSource(
      base,
      producerStage,
      { kind: "fileExists", path: "done" },
      "NEXT",
      fakeSource({
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      }),
      {} as never,
      defaultExtensionRegistry,
      "SEED",
    );
    expect(await src.pull(1)).toBe(task);
    expect(scheduled).toEqual([]);
  });

  it("passes later iterations straight through to the base source", async () => {
    const base = { pull: vi.fn(async () => null) };
    const src = new GeneratorWorkSource(
      base,
      producerStage,
      { kind: "fileExists", path: "done" },
      "NEXT",
      fakeSource(),
      {} as never,
      defaultExtensionRegistry,
      "SEED",
    );
    expect(await src.pull(2)).toBeNull();
    expect(base.pull).toHaveBeenCalledTimes(1);
  });

  it("throws when the producer stage fails", async () => {
    const src = new GeneratorWorkSource(
      { pull: async () => null },
      producerStage,
      { kind: "fileExists", path: "done" },
      "NEXT",
      fakeSource(),
      {} as never,
      defaultExtensionRegistry,
    );
    await expect(
      src.afterTask(makeCtx(async () => ({ success: false }))),
    ).rejects.toThrow("Goal producer failed.");
  });

  it("throws when the completion predicate is not registered", async () => {
    const src = new GeneratorWorkSource(
      { pull: async () => null },
      producerStage,
      { kind: "notAPredicate", path: "done" },
      "NEXT",
      fakeSource(),
      {} as never,
      defaultExtensionRegistry,
    );
    await expect(
      src.afterTask(makeCtx(async () => ({ success: true }))),
    ).rejects.toThrow("Predicate 'notAPredicate' is not registered.");
  });

  it("passes a produced task straight through without consulting the trigger", async () => {
    const src = new TriggerWorkSource(
      { pull: async () => task } as WorkSource,
      { kind: "taskAppears", source: "q.md", pollIntervalMs: 5 } as never,
      fakeSource(),
      { getFirstUncheckedTask: async () => null },
      {} as never,
      {
        trigger: () => {
          throw new Error("trigger should not be consulted");
        },
      } as never,
    );
    expect(await src.pull(1)).toBe(task);
  });

  it("resets the inner source and re-pulls when the trigger fires", async () => {
    let inner = false;
    const src = new TriggerWorkSource(
      {
        pull: async () => (inner ? task : null),
        reset: () => {
          inner = true;
        },
      } as WorkSource,
      { kind: "taskAppears", source: "q.md", pollIntervalMs: 5 } as never,
      fakeSource(),
      { getFirstUncheckedTask: async () => null },
      {} as never,
      {
        trigger: () => ({ callback: async () => ({ reason: "fired" }) }),
      } as unknown as ExtensionRegistry,
    );
    expect(await src.pull(1)).toBe(task);
  });

  it("returns null when the trigger declines to fire", async () => {
    const src = new TriggerWorkSource(
      { pull: async () => null } as WorkSource,
      { kind: "taskAppears", source: "q.md", pollIntervalMs: 5 } as never,
      fakeSource(),
      { getFirstUncheckedTask: async () => null },
      {} as never,
      {
        trigger: () => ({ callback: async () => null }),
      } as unknown as ExtensionRegistry,
    );
    expect(await src.pull(1)).toBeNull();
  });

  it("throws when the trigger kind is not registered", async () => {
    const src = new TriggerWorkSource(
      { pull: async () => null } as WorkSource,
      { kind: "missing", source: "q.md", pollIntervalMs: 5 } as never,
      fakeSource(),
      { getFirstUncheckedTask: async () => null },
      {} as never,
      { trigger: () => undefined } as unknown as ExtensionRegistry,
    );
    await expect(src.pull(1)).rejects.toThrow(
      "Trigger 'missing' is not registered.",
    );
  });
});

describe("GeneratorWorkSource scheduling", () => {
  const makeCtx2 = (): CoreContext =>
    ({
      workspace: "/ws",
      iteration: 1,
      task,
      runStage: async () => ({ success: true }),
      expand: (value: string) => value,
    }) as never;

  it("schedules the next task when work is not yet complete", async () => {
    const scheduled: string[] = [];
    const src = new GeneratorWorkSource(
      { pull: async () => null },
      producerStage,
      { kind: "fileExists", path: "definitely-missing-file-xyz" },
      "NEXT - keep going",
      fakeSource({
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      }),
      {} as never,
      defaultExtensionRegistry,
    );
    await src.afterTask(makeCtx2());
    expect(scheduled).toEqual(["NEXT - keep going"]);
  });
});
