import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/engine-core.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import { run } from "../../src/core/pipeline.js";
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

const source = (tasks: readonly (Task | null)[]): TaskSource => ({
  getFirstUncheckedTask: async () => tasks[0] ?? null,
  remediationDepth: async () => ({ depth: 0, rootId: task.id }),
  isTaskUnchecked: async () => false,
  checkTask: async () => undefined,
  scheduleTask: async () => undefined,
  seedBlueprintTask: async () => null,
});

const stage = {
  name: "work",
  failureTask: "FIX-001 - repair",
  command: { run: "echo" },
} as never;

const step = (
  result: boolean,
  policy: Step["onFail"] = { kind: "stop" },
): Step => ({
  name: "work",
  role: "harness",
  onFail: policy,
  run: async () => ({
    success: result,
    process: {
      exitCode: result ? 0 : 1,
      signal: null,
      timedOut: false,
      cancelled: false,
    },
  }),
});

describe("CoreEngine", () => {
  it("runs a plan and emits task and iteration events", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-core-"));
    try {
      const events: string[] = [];
      const plan: CorePlan = {
        workspace,
        maxIterations: 2,
        source: {
          ...source([task, null]),
          pull: async (iteration) => (iteration === 1 ? task : null),
        },
        steps: [step(true)],
        guards: [],
        status: () => "working",
      };
      const result = await new CoreEngine(new FakeProcessRunner(), source([]), {
        onEvent: (event) => {
          events.push(event.type);
        },
      }).run(plan);
      expect(result.status).toBe("complete");
      expect(events).toEqual(["task.started"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sets root to originating task for remediation stages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-core-root-"));
    const remediation: Task = {
      ...task,
      typ: "VERIFY",
      num: "001",
      id: "VERIFY-001",
      description: "Verify TASK-001 (parent: TASK-001)",
      rawLine: "- [ ] VERIFY-001 - Verify TASK-001 (parent: TASK-001)",
    };
    try {
      let root: unknown;
      const taskSource: TaskSource = {
        ...source([]),
        remediationDepth: async () => ({ depth: 1, rootId: "TASK-001" }),
      };
      const plan: CorePlan = {
        workspace,
        maxIterations: 1,
        source: { ...taskSource, pull: async () => remediation },
        steps: [
          {
            ...step(true),
            run: async (ctx) => {
              root = ctx.root;
              return { success: true };
            },
          },
        ],
        guards: [],
        status: () => "working",
      };

      await new CoreEngine(new FakeProcessRunner(), taskSource).run(plan);
      expect(root).toBe("TASK-001");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("supports the async engine entry point", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-core-async-"));
    try {
      const plan: CorePlan = {
        workspace,
        maxIterations: 1,
        source: { ...source([]), pull: async () => null },
        steps: [],
        guards: [],
        status: () => "working",
      };
      await expect(
        new CoreEngine(new FakeProcessRunner(), source([])).runAsync(plan),
      ).resolves.toMatchObject({ status: "complete", exitCode: 0 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns process failure for a stopped step", async () => {
    const outcome = await run(
      [step(false)],
      {
        workspace: "/workspace",
        iteration: 1,
        task,
      },
      1,
    );
    expect(outcome).toMatchObject({ terminal: true, status: "processFailure" });
  });

  it("returns canceled before pulling work", async () => {
    const controller = new AbortController();
    controller.abort();
    const plan: CorePlan = {
      workspace: "/workspace",
      maxIterations: 1,
      source: { ...source([]), pull: async () => null },
      steps: [],
      guards: [],
      status: () => "",
    };
    const result = await new CoreEngine(
      new FakeProcessRunner(),
      source([]),
    ).run(plan, {
      signal: controller.signal,
    });
    expect(result.status).toBe("canceled");
  });

  it("trips a guard after a successful iteration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-guard-"));
    try {
      const plan: CorePlan = {
        workspace,
        maxIterations: 1,
        source: { ...source([]), pull: async () => task },
        steps: [step(true)],
        guards: [
          { kind: "guard", threshold: 1, signature: async () => "same" },
        ],
        status: () => "working",
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        source([]),
      ).run(plan);
      expect(result.status).toBe("blocked");
      expect(result.events.at(-1)?.type).toBe("circuitBreaker.tripped");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("checks engine-owned tasks before continuation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-completion-"));
    try {
      const order: string[] = [];
      const taskSource = {
        ...source([]),
        pull: async () => task,
        checkTask: async () => {
          order.push("check");
        },
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        taskSource,
      ).run({
        workspace,
        maxIterations: 1,
        source: {
          ...taskSource,
          afterTask: async () => {
            order.push("after");
          },
        },
        completeTask: true,
        steps: [step(true)],
        guards: [],
        status: () => "working",
      });
      expect(result.status).toBe("iterationLimit");
      expect(order).toEqual(["check", "after"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks when engine-owned task completion fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-completion-error-"));
    try {
      const afterTask = vi.fn(async () => undefined);
      const taskSource = {
        ...source([]),
        pull: async () => task,
        checkTask: async () => {
          throw new Error("write failed");
        },
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        taskSource,
      ).run({
        workspace,
        maxIterations: 1,
        source: { ...taskSource, afterTask },
        completeTask: true,
        steps: [step(true)],
        guards: [],
        status: () => "working",
      });
      expect(result).toMatchObject({
        status: "blocked",
        message: "Task completion failed: write failed",
      });
      expect(afterTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns iteration limit when work never exhausts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-limit-"));
    try {
      const plan: CorePlan = {
        workspace,
        maxIterations: 1,
        source: { ...source([]), pull: async () => task },
        steps: [step(true)],
        guards: [],
        status: () => "working",
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        source([]),
      ).run(plan);
      expect(result.status).toBe("iterationLimit");
      expect(result.exitCode).toBe(4);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("continues and retries according to policy", async () => {
    let attempts = 0;
    const retry = step(false, {
      kind: "retry",
      times: 1,
      predicate: { check: async () => true },
    });
    retry.run = async () => {
      attempts++;
      return { success: attempts === 2 };
    };
    const outcome = await run(
      [step(false, { kind: "continue" }), retry],
      { workspace: "/workspace", iteration: 1, task },
      1,
    );
    expect(outcome).toMatchObject({ terminal: false });
    expect(attempts).toBe(2);
  });

  it("reports scheduled policy outcomes", async () => {
    let scheduled = false;
    const outcome = await run(
      [step(false, { kind: "schedule", action: "fix", maxAttempts: 1 })],
      {
        workspace: "/workspace",
        iteration: 1,
        task,
        schedule: async () => {
          scheduled = true;
          return "scheduled";
        },
      },
      1,
    );
    expect(outcome).toMatchObject({
      terminal: false,
      scheduled: true,
    });
    expect(scheduled).toBe(true);
  });

  it("schedules a failed staged step through the registered action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-schedule-"));
    try {
      const scheduled: string[] = [];
      const taskSource = {
        ...source([]),
        pull: async () => task,
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        taskSource,
      ).run({
        workspace,
        maxIterations: 1,
        source: { ...taskSource, pull: async () => task },
        steps: [
          {
            ...step(false, {
              kind: "schedule",
              action: "scheduleTask",
              maxAttempts: 1,
            }),
            stage,
          },
        ],
        guards: [],
        status: () => "working",
      });
      expect(result.status).toBe("iterationLimit");
      expect(scheduled).toEqual(["FIX-001 - repair"]);
      expect(result.events.map((event) => event.type)).toContain(
        "fix.scheduled",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("defers guards and continuation until scheduled remediation runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-remediation-"));
    try {
      const scheduled: string[] = [];
      let guardRuns = 0;
      let continuationRuns = 0;
      const taskSource = {
        ...source([]),
        pull: async () => task,
        scheduleTask: async (line: string) => {
          scheduled.push(line);
        },
      };
      const result = await new CoreEngine(
        new FakeProcessRunner(),
        taskSource,
      ).run({
        workspace,
        maxIterations: 1,
        source: {
          ...taskSource,
          afterTask: async () => {
            continuationRuns++;
          },
        },
        steps: [
          {
            ...step(false, {
              kind: "schedule",
              action: "scheduleTask",
              maxAttempts: 1,
            }),
            stage,
          },
        ],
        guards: [
          {
            kind: "must-not-run",
            threshold: 1,
            signature: async () => {
              guardRuns++;
              return "failure";
            },
          },
        ],
        status: () => "working",
      });

      expect(result.status).toBe("iterationLimit");
      expect(scheduled).toEqual(["FIX-001 - repair"]);
      expect(guardRuns).toBe(0);
      expect(continuationRuns).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks when schedule handling is unavailable", async () => {
    const outcome = await run(
      [step(false, { kind: "schedule", action: "fix", maxAttempts: 1 })],
      { workspace: "/workspace", iteration: 1, task },
      1,
    );
    expect(outcome).toMatchObject({
      terminal: true,
      status: "blocked",
      message: "Action 'fix' is not available.",
    });
  });

  it("handles source, context, status, callback, and after-task failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-source-"));
    try {
      const callbackEvents: string[] = [];
      const callbacks = {
        onEvent: async (event: { type: string }) => {
          callbackEvents.push(event.type);
        },
        onStatus: async (status: string) => {
          callbackEvents.push(status);
        },
      };
      const sourceError = await new CoreEngine(
        new FakeProcessRunner(),
        source([]),
      ).run({
        workspace,
        maxIterations: 1,
        source: {
          ...source([]),
          pull: async () => {
            throw new Error("source failed");
          },
        },
        steps: [],
        guards: [],
        status: () => "",
      });
      expect(sourceError).toMatchObject({
        status: "blocked",
        message: "source failed",
      });

      const afterTaskError = await new CoreEngine(
        new FakeProcessRunner(),
        source([]),
        callbacks,
      ).run({
        workspace,
        maxIterations: 1,
        source: {
          ...source([]),
          pull: async () => task,
          afterTask: async () => {
            throw new Error("after failed");
          },
        },
        steps: [],
        guards: [],
        context: (ctx) => ({ marker: ctx.task.id }),
        status: (ctx) => String(ctx.marker),
      });
      expect(afterTaskError).toMatchObject({
        status: "blocked",
        message: "after failed",
      });
      expect(callbackEvents).toContain("TASK-001");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks when retry predicate declines another attempt", async () => {
    const outcome = await run(
      [
        step(false, {
          kind: "retry",
          times: 1,
          predicate: { check: async () => false },
        }),
      ],
      { workspace: "/workspace", iteration: 1, task },
      1,
    );
    expect(outcome).toMatchObject({ terminal: true, status: "blocked" });
  });
});
