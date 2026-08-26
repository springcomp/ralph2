import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type StagePlan,
  type WorkflowPlan,
  compileCore,
} from "../../src/config/compiler.js";
import { lowerSteps } from "../../src/config/lowering/steps.js";
import {
  BlueprintRefill,
  ChainedWorkSource,
  GeneratorWorkSource,
  PrdSource,
  TriggerWorkSource,
  lowerWorkSource,
} from "../../src/config/lowering/worksource.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import type { Task } from "../../src/core/task.js";
import type { TaskSource } from "../../src/core/task.js";
import {
  createExtensionRegistry,
  defaultExtensionRegistry,
} from "../../src/extensions/registry.js";
import type { ExtensionEvent } from "../../src/extensions/types.js";

const task: Task = {
  typ: "TASK",
  num: "001",
  id: "TASK-001",
  description: "Do work",
  rawLine: "- [ ] TASK-001 - Do work",
  lineIndex: 0,
};

const stage = (name: string, changes: Partial<StagePlan> = {}): StagePlan => ({
  name,
  executable: "node",
  arguments: ["{TASK}"],
  conditionalArguments: [],
  environment: [{ name: "STAGE", value: name, secret: false }],
  timeoutMs: 1000,
  successExitCodes: [0],
  failurePolicy: "stop",
  ...changes,
});

const plan = (
  root: string,
  changes: Partial<WorkflowPlan> = {},
): WorkflowPlan => ({
  workspace: root,
  environment: [{ name: "GLOBAL", value: "{TASK}", secret: false }],
  envFilePath: undefined,
  maxIterations: 3,
  maxRemediationAttempts: 2,
  tasks: {
    prd: join(root, "PRD.md"),
    progress: "",
    prompt: "",
    completionSignal: "",
  },
  harnesses: { harness: stage("harness") },
  defaultHarness: "harness",
  model: "model",
  agent: "agent",
  preAgent: [],
  postAgent: [],
  verification: { requireTaskChecked: false, retries: 0 },
  statusFormat: "{TASK}",
  ...changes,
});

const source = (overrides: Partial<TaskSource> = {}): TaskSource => ({
  getFirstUncheckedTask: vi.fn(async () => task),
  remediationDepth: vi.fn(async () => ({ depth: 0, rootId: task.id })),
  isTaskUnchecked: vi.fn(async () => false),
  checkTask: vi.fn(async () => undefined),
  scheduleTask: vi.fn(async () => undefined),
  seedBlueprintTask: vi.fn(async () => null),
  ...overrides,
});

describe("step lowering", () => {
  it("runs stages, expands values, loads env files, emits events, and validates artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-lowering-"));
    try {
      const envPath = join(root, ".env");
      const resultPath = join(root, "result.json");
      await writeFile(envPath, "FROM_FILE=loaded\n");
      await writeFile(resultPath, '{"ok":true}');
      const workflow = plan(root, {
        envFilePath: envPath,
        verification: {
          requireTaskChecked: true,
          retries: 2,
          prompt: "Check {TASK}",
        },
        postAgent: [
          stage("post", {
            resultPath,
            resultRequired: true,
            outputPath: join(root, "out.log"),
            failureAction: "scheduleTask",
            failureTask: "Fix it",
          }),
        ],
      });
      const runner = new FakeProcessRunner([
        { exitCode: 0, signal: null, timedOut: false, cancelled: false },
        { exitCode: 0, signal: null, timedOut: false, cancelled: false },
        { exitCode: 0, signal: null, timedOut: false, cancelled: false },
      ]);
      const events: string[] = [];
      const steps = lowerSteps(workflow, source(), undefined);
      expect(steps.map((step) => [step.name, step.role])).toEqual([
        ["harness", "harness"],
        ["post", "post"],
        ["verify", "verify"],
      ]);
      expect(steps[0].onFail).toEqual({ kind: "stop" });
      expect(steps[1].onFail).toMatchObject({
        kind: "schedule",
        maxAttempts: 2,
      });
      await steps[0].run({
        workspace: root,
        iteration: 1,
        task,
        runner,
        emit: async (event: ExtensionEvent) =>
          events.push(`${event.type}:${event.stage}`),
      });
      await steps[1].run({
        workspace: root,
        iteration: 1,
        task,
        runner,
        emit: async (event: ExtensionEvent) =>
          events.push(`${event.type}:${event.stage}`),
      });
      const verify = steps[2].run({
        workspace: root,
        iteration: 1,
        task,
        runner,
        emit: async (event: ExtensionEvent) =>
          events.push(`${event.type}:${event.stage}`),
      });
      await verify;
      expect(runner.requests[1].env).toMatchObject({
        FROM_FILE: { value: "loaded", secret: false },
        GLOBAL: { value: task.description, secret: false },
      });
      expect(
        await readFile(
          join(root, ".agentic", "__verification.prompt.md"),
          "utf8",
        ),
      ).toBe(`Check ${task.description}`);
      expect(events).toHaveLength(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports failed, timed out, canceled, and invalid artifact stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-lowering-"));
    try {
      const resultPath = join(root, "bad.json");
      await writeFile(resultPath, "[]");
      const workflow = plan(root, {
        postAgent: [
          stage("bad", { resultPath, resultRequired: true, mandatory: false }),
        ],
      });
      const runner = new FakeProcessRunner([
        { exitCode: 1, signal: null, timedOut: false, cancelled: false },
        { exitCode: null, signal: null, timedOut: true, cancelled: false },
        { exitCode: null, signal: null, timedOut: false, cancelled: true },
      ]);
      const steps = lowerSteps(
        plan(root, { postAgent: [stage("bad", { mandatory: false })] }),
        source(),
      );
      expect(steps[1].onFail).toEqual({ kind: "continue" });
      const post = steps[1];
      expect(
        (await post.run({ workspace: root, iteration: 1, task, runner }))
          .success,
      ).toBe(false);
      expect(
        (await post.run({ workspace: root, iteration: 1, task, runner }))
          .success,
      ).toBe(false);
      expect(
        (await post.run({ workspace: root, iteration: 1, task, runner }))
          .success,
      ).toBe(false);
      const artifactPost = lowerSteps(workflow, source())[1];
      expect(
        (
          await artifactPost.run({
            workspace: root,
            iteration: 1,
            task,
            runner: new FakeProcessRunner([
              { exitCode: 0, signal: null, timedOut: false, cancelled: false },
            ]),
          })
        ).success,
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("work-source lowering", () => {
  it("lowers a custom continuation through the registry", () => {
    const custom = {
      pull: vi.fn(async () => task),
    };
    const registry = createExtensionRegistry({
      continuationLowerings: [
        {
          name: "custom",
          lower: () => custom,
        },
      ],
    });
    const workflow = plan("C:\\workspace", {
      continuation: {
        kind: "custom",
        seedPrdFromSource: false,
        completeWhenSourceExhausted: false,
      },
    });

    const lowered = lowerWorkSource(workflow, source(), registry);
    expect(lowered).toBe(custom);
  });

  it("passes a custom continuation kind's own properties through compileCore untouched", () => {
    const custom = { pull: vi.fn(async () => task) };
    let received: unknown;
    const registry = createExtensionRegistry({
      continuationLowerings: [
        {
          name: "custom",
          lower: (dto) => {
            received = dto;
            return custom;
          },
        },
      ],
    });
    const doc = {
      schemaVersion: 1 as const,
      workspace: ".",
      maxIterations: 1,
      tasks: { prd: "PRD.md", progress: "progress.txt", prompt: "prompt.md" },
      defaults: { harness: "harness" },
      harnesses: { harness: { executable: "node" } },
      continuation: { kind: "custom", pollUrl: "https://example.test/status" },
    };

    const core = compileCore(doc, "C:\\workspace", source(), {}, registry);

    expect(core.source).toBe(custom);
    expect(received).toMatchObject({
      kind: "custom",
      pollUrl: "https://example.test/status",
    });
  });

  it("pulls PRD tasks, refills blueprints, chains sources, and handles generated goals", async () => {
    const first = source();
    expect(await new PrdSource(first, "prd").pull()).toBe(task);
    const refill = new BlueprintRefill(first, "prd", "blueprint");
    await refill.pull();
    expect(first.seedBlueprintTask).toHaveBeenCalled();
    const empty = source({ getFirstUncheckedTask: vi.fn(async () => null) });
    const chained = new ChainedWorkSource([
      new PrdSource(empty, "prd"),
      new PrdSource(first, "prd"),
    ]);
    expect(await chained.pull(1)).toBe(task);

    const schedule = vi.fn(async () => undefined);
    const complete = vi.fn(async () => false);
    const extensions = createExtensionRegistry({
      producers: [{ name: "producer", create: () => ({ executable: "node" }) }],
      predicates: [
        { name: "done", description: "", properties: [], callback: complete },
      ],
    });
    const root = "C:\\workspace";
    const workflow = plan(root, {
      continuation: {
        kind: "generatedGoal",
        producer: stage("producer"),
        completeWhen: { kind: "done" },
        nextTask: "next {TASK}",
        seedPrdFromSource: false,
        completeWhenSourceExhausted: false,
      },
    });
    const generated = new GeneratorWorkSource(
      new PrdSource(first, "prd"),
      stage("producer"),
      { kind: "done" },
      "next {TASK}",
      source({ scheduleTask: schedule }),
      workflow,
      extensions,
    );
    await generated.afterTask({
      workspace: root,
      iteration: 1,
      task,
      runStage: async () => ({ success: true }),
      expand: (value: string) => value.replace("{TASK}", task.id),
    });
    expect(schedule).toHaveBeenCalledWith(
      "C:\\workspace\\PRD.md",
      "next TASK-001",
    );
  });

  it("seeds an empty PRD only on the initial pull", async () => {
    const seeded = source();
    const getTask = seeded.getFirstUncheckedTask as ReturnType<typeof vi.fn>;
    getTask
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(null);
    const schedule = seeded.scheduleTask as ReturnType<typeof vi.fn>;
    const workflow = plan("C:\\workspace");
    const generated = new GeneratorWorkSource(
      new PrdSource(seeded, "prd"),
      stage("producer"),
      { kind: "done" },
      "next {TASK}",
      seeded,
      workflow,
      defaultExtensionRegistry,
      "- [ ] GOAL-{ITERATION:000} - Seed {TASK}",
    );

    expect(await generated.pull(1)).toBe(task);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(
      "C:\\workspace\\PRD.md",
      "- [ ] GOAL-{ITERATION:000} - Seed {TASK}",
    );
    expect(await generated.pull(2)).toBeNull();
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("does not seed a non-empty or unconfigured initial PRD", async () => {
    const nonEmpty = source();
    const nonEmptyGenerated = new GeneratorWorkSource(
      new PrdSource(nonEmpty, "prd"),
      stage("producer"),
      { kind: "done" },
      "next",
      nonEmpty,
      plan("C:\\workspace"),
      defaultExtensionRegistry,
      "seed",
    );
    expect(await nonEmptyGenerated.pull(1)).toBe(task);
    expect(nonEmpty.scheduleTask).not.toHaveBeenCalled();

    const empty = source({ getFirstUncheckedTask: vi.fn(async () => null) });
    const unconfigured = new GeneratorWorkSource(
      new PrdSource(empty, "prd"),
      stage("producer"),
      { kind: "done" },
      "next",
      empty,
      plan("C:\\workspace"),
      defaultExtensionRegistry,
    );
    expect(await unconfigured.pull(1)).toBeNull();
    expect(empty.scheduleTask).not.toHaveBeenCalled();
  });

  it("waits on triggers and reports missing registrations", async () => {
    const inner = {
      pull: vi.fn(async (_iteration: number): Promise<Task | null> => null),
    };
    inner.pull.mockResolvedValueOnce(null).mockResolvedValueOnce(task);
    const trigger = vi.fn(async () => ({ reason: "new task" }));
    const extensions = createExtensionRegistry({
      triggers: [
        { name: "wait", description: "", properties: [], callback: trigger },
      ],
    });
    const workflow = plan("C:\\workspace", {
      trigger: { kind: "wait", source: "PRD.md", pollIntervalMs: 1 },
    });
    if (!workflow.trigger) throw new Error("test trigger missing");
    const wrapped = new TriggerWorkSource(
      inner,
      workflow.trigger,
      source(),
      workflow,
      extensions,
    );
    expect(await wrapped.pull(1)).toBe(task);
    expect(trigger).toHaveBeenCalled();
    const missing = new TriggerWorkSource(
      inner,
      { ...workflow.trigger, kind: "missing" },
      source(),
      workflow,
      extensions,
    );
    await expect(missing.pull(1)).rejects.toThrow("not registered");
  });

  it("composes configured source layers", () => {
    const workflow = plan("C:\\workspace", {
      continuation: {
        kind: "blueprint",
        source: "blueprint.md",
        seedPrdFromSource: true,
        completeWhenSourceExhausted: true,
      },
      trigger: { kind: "wait", source: "PRD.md", pollIntervalMs: 1 },
    });
    const registry = createExtensionRegistry({
      triggers: [
        {
          name: "wait",
          description: "",
          properties: [],
          callback: async () => null,
        },
      ],
    });
    expect(lowerWorkSource(workflow, source(), registry)).toBeInstanceOf(
      TriggerWorkSource,
    );
  });

  it("resets a chained work source so a retry re-checks drained sub-sources", async () => {
    let hasTask = false;
    const second = source({
      getFirstUncheckedTask: vi.fn(async () => (hasTask ? task : null)),
    });
    const chained = new ChainedWorkSource([
      new PrdSource(source({ getFirstUncheckedTask: vi.fn(async () => null) }), "prd"),
      new PrdSource(second, "prd"),
    ]);
    expect(await chained.pull(1)).toBeNull();
    hasTask = true;
    expect(await chained.pull(1)).toBeNull();
    chained.reset();
    expect(await chained.pull(1)).toBe(task);
  });

  it("blueprint continuation resumes once taskAppears detects a task appended to BLUEPRINT.md", async () => {
    const prdPath = join("C:\\workspace", "PRD.md");
    const blueprintPath = join("C:\\workspace", "BLUEPRINT.md");
    let prdHasTask = false;
    let blueprintHasNewTask = false;
    const taskSource = source({
      getFirstUncheckedTask: vi.fn(async (path?: string) => {
        if (path === prdPath) return prdHasTask ? task : null;
        if (path === blueprintPath) return blueprintHasNewTask ? task : null;
        return null;
      }),
      seedBlueprintTask: vi.fn(async () => {
        if (blueprintHasNewTask) {
          prdHasTask = true;
          blueprintHasNewTask = false;
        }
        return null;
      }),
    });
    const workflow = plan("C:\\workspace", {
      tasks: { prd: prdPath, progress: "", prompt: "", completionSignal: "" },
      continuation: {
        kind: "blueprint",
        source: blueprintPath,
        seedPrdFromSource: true,
        completeWhenSourceExhausted: true,
      },
      trigger: { kind: "taskAppears", source: blueprintPath, pollIntervalMs: 5 },
    });
    const lowered = lowerWorkSource(workflow, taskSource, defaultExtensionRegistry);
    expect(lowered).toBeInstanceOf(TriggerWorkSource);

    setTimeout(() => {
      blueprintHasNewTask = true;
    }, 20);

    expect(await lowered.pull(1)).toBe(task);
  });

  it("lowers compileCore guards and status", async () => {
    const doc = {
      schemaVersion: 1 as const,
      workspace: ".",
      maxIterations: 1,
      tasks: { prd: "PRD.md", progress: "progress.txt", prompt: "prompt.md" },
      defaults: { harness: "harness" },
      harnesses: { harness: { executable: "node" } },
      circuitBreaker: { checks: [{ kind: "repeatedFailure", threshold: 2 }] },
    };
    const registry = createExtensionRegistry({
      circuitBreakers: [
        {
          name: "repeatedFailure",
          description: "",
          properties: [],
          callback: async () => "sig",
        },
      ],
    });
    const core = compileCore(doc, "C:\\workspace", source(), {}, registry);
    expect(
      core.status({ workspace: "C:\\workspace", iteration: 1, task }),
    ).toBe("🔄️ Iteration 001 - TASK-001 - Do work (model: ``)");
    expect(core.guards).toHaveLength(1);
    expect(
      await core.guards[0].signature({
        workspace: "C:\\workspace",
        iteration: 1,
        task,
      }),
    ).toBe("sig");
  });
});
