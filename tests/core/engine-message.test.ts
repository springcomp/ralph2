import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const successStep = (onSuccess: Step["onSuccess"]): Step => ({
  name: "notify",
  role: "post",
  onFail: { kind: "stop" },
  onSuccess,
  run: async () => ({ success: true }),
});

const runEngine = async (
  workspace: string,
  step: Step,
): Promise<{ status: string; message: string; events: string[] }> => {
  const plan: CorePlan = {
    workspace,
    maxIterations: 1,
    source: { ...source(), pull: async () => task },
    steps: [step],
    guards: [],
    status: () => "working",
  };
  const result = await new CoreEngine(new FakeProcessRunner(), source()).run(
    plan,
  );
  return {
    status: result.status,
    message: result.message,
    events: result.events.map((event) => event.type),
  };
};

describe("CoreEngine onSuccess message dispatch", () => {
  it("blocks when the message kind is not registered", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-msg-"));
    try {
      const result = await runEngine(
        workspace,
        successStep({
          message: "notARealMessage",
          target: "BLUEPRINT.md",
          task: "- [ ] MSG-001 - hi",
        }),
      );
      expect(result).toMatchObject({
        status: "blocked",
        message: "Message 'notARealMessage' is not registered.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("appends a checkable task to the configured target via the built-in addTask message", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-msg-"));
    try {
      const target = join(workspace, "BLUEPRINT.md");
      const result = await runEngine(
        workspace,
        successStep({
          message: "addTask",
          target,
          task: "- [ ] MSG-001 - Heartbeat",
        }),
      );
      expect(result.status).toBe("iterationLimit");
      expect(result.events).toContain("message.sent");
      expect(await readFile(target, "utf8")).toContain(
        "- [ ] MSG-001 - Heartbeat",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks when the message task line is invalid", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-msg-"));
    try {
      const target = join(workspace, "BLUEPRINT.md");
      const result = await runEngine(
        workspace,
        successStep({
          message: "addTask",
          target,
          task: "not a task line",
        }),
      );
      expect(result.status).toBe("blocked");
      expect(result.message).toContain("Message send failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
