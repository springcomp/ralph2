import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/engine-core.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import type { CorePlan, Guard, Step } from "../../src/core/plan.js";
import type { Task, TaskSource } from "../../src/core/task.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const source = (): TaskSource => ({
  getFirstUncheckedTask: async () => null,
  remediationDepth: async () => ({ depth: 0, rootId: task.id }),
  isTaskUnchecked: async () => false,
  checkTask: async () => undefined,
  scheduleTask: async () => undefined,
  seedBlueprintTask: async () => null,
});

const okStep: Step = {
  name: "work",
  role: "harness",
  onFail: { kind: "stop" },
  run: async () => ({ success: true }),
};

const runWithGuard = async (guard: Guard, maxIterations = 1) => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-guards-"));
  try {
    const plan: CorePlan = {
      workspace,
      maxIterations,
      source: { ...source(), pull: async () => task },
      steps: [okStep],
      guards: [guard],
      status: () => "working",
    };
    const result = await new CoreEngine(new FakeProcessRunner(), source()).run(
      plan,
    );
    return result.events.map((event) => event.type);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

describe("CoreEngine guard evaluation", () => {
  it("emits a reset event when a guard signature is null", async () => {
    const events = await runWithGuard({
      kind: "resetting",
      threshold: 2,
      signature: async () => null,
    });
    expect(events).toContain("circuitBreaker.reset");
  });

  it("emits a streak event when the threshold is not yet reached", async () => {
    const events = await runWithGuard({
      kind: "streaking",
      threshold: 5,
      signature: async () => "same",
    });
    expect(events).toContain("circuitBreaker.streak");
    expect(events).not.toContain("circuitBreaker.tripped");
  });

  it("emits an error event and continues when a guard signature throws", async () => {
    const events = await runWithGuard({
      kind: "throwing",
      threshold: 2,
      signature: async () => {
        throw new Error("guard boom");
      },
    });
    expect(events).toContain("circuitBreaker.error");
  });

  it("passes the last continued failure into the guard signature", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-guards-fail-"));
    try {
      let seen: unknown;
      const failingContinue: Step = {
        name: "gate",
        role: "post",
        onFail: { kind: "continue" },
        run: async () => ({
          success: false,
          process: {
            exitCode: 9,
            signal: null,
            timedOut: false,
            cancelled: false,
          },
        }),
      };
      const plan: CorePlan = {
        workspace,
        maxIterations: 1,
        source: { ...source(), pull: async () => task },
        steps: [failingContinue],
        guards: [
          {
            kind: "inspecting",
            threshold: 5,
            signature: async (ctx) => {
              seen = (ctx as { lastFailure?: unknown }).lastFailure;
              return "sig";
            },
          },
        ],
        status: () => "working",
      };
      await new CoreEngine(new FakeProcessRunner(), source()).run(plan);
      expect(seen).toEqual({ stage: "gate", exitCode: 9 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
