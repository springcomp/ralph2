import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StagePlan } from "../../src/config/compiler.js";
import type { ProcessResult } from "../../src/core/process-runner.js";
import type { TaskSource } from "../../src/core/task.js";
import { scheduleTaskAction } from "../../src/extensions/actions/schedule-task.js";
import { repeatedFailureSignatureCircuitBreaker } from "../../src/extensions/circuit-breakers/repeated-failure-signature.js";
import { acceptedExitCodePredicate } from "../../src/extensions/predicates/accepted-exit-code.js";
import { fileExistsPredicate } from "../../src/extensions/predicates/file-exists.js";
import { fileMissingPredicate } from "../../src/extensions/predicates/file-missing.js";
import {
  createExtensionRegistry,
  defaultExtensionRegistry,
} from "../../src/extensions/registry.js";
import type { PlaceholderContext } from "../../src/placeholders/placeholders.js";

describe("extension registry - built-in templates", () => {
  it("registers the goal template", () => {
    expect(defaultExtensionRegistry.template("goal")).toBeDefined();
  });

  it("registers the blueprint template", () => {
    expect(defaultExtensionRegistry.template("blueprint")).toBeDefined();
  });

  it("goal template has required files", () => {
    const reg = defaultExtensionRegistry.template("goal");
    expect(reg?.files.get("ralph.yaml")).toContain("generatedGoal");
    expect(reg?.files.get("ralph.yaml")).toContain("schemaVersion: 1");
    expect(reg?.files.get("ralph.prompt.md")).toBeDefined();
    expect(reg?.files.get("GOAL.md")).toBeDefined();
    expect(reg?.files.get("queue.md")).toBeDefined();
    expect(reg?.files.has("PRD.md")).toBe(false);
    expect(reg?.files.get("progress.txt")).toBeDefined();
  });

  it("goal template yaml contains fileMissing, marker path, timeout, seedTask, and nextTask", () => {
    const yaml =
      defaultExtensionRegistry.template("goal")?.files.get("ralph.yaml") ?? "";
    expect(yaml).toContain("fileMissing");
    expect(yaml).toContain(".agentic/__remaining_failures.log");
    expect(yaml).toContain("15m");
    expect(yaml).toContain('seedTask: "- [ ] GOAL-001 - Define first goal"');
    expect(yaml).toContain("GOAL-{ITERATION:000}");
  });

  it("goal template starts with goal intent and an empty queue", () => {
    const files = defaultExtensionRegistry.template("goal")?.files;
    expect(files?.get("GOAL.md")).toBe("# Goal\n\n");
    expect(files?.get("queue.md")).toContain("Ralph execution queue");
    expect(files?.has("PRD.md")).toBe(false);
    expect(files?.get("ralph.yaml")).toContain("queue: .agentic/queue.md");
  });

  it("blueprint template emits goal and queue files without a goal PRD", () => {
    const files = defaultExtensionRegistry.template("blueprint")?.files;
    expect(files?.get("GOAL.md")).toBe("# Goal\n\n");
    expect(files?.get("queue.md")).toContain("Ralph execution queue");
    expect(files?.has("PRD.md")).toBe(false);
    expect(files?.get("ralph.yaml")).toContain("queue: .agentic/queue.md");
    expect(files?.get("ralph.prompt.md")).toContain("{QUEUE}");
    expect(files?.get("ralph.prompt.md")).not.toContain("{PRD}");
  });

  it("blueprint template reuses goal files and configures source seeding", () => {
    const goal = defaultExtensionRegistry.template("goal");
    const blueprint = defaultExtensionRegistry.template("blueprint");
    expect(blueprint?.files.get("ralph.prompt.md")).not.toBe(
      goal?.files.get("ralph.prompt.md"),
    );
    expect(blueprint?.files.get("ralph.prompt.md")).toContain("{QUEUE}");
    expect(blueprint?.files.get("ralph.prompt.md")).not.toContain("{PRD}");
    expect(blueprint?.files.get("ralph.prompt.md")).toContain("{PROGRESS}");
    expect(blueprint?.files.get("progress.txt")).toBe(
      goal?.files.get("progress.txt"),
    );
    expect(blueprint?.files.get("ralph.yaml")).toContain("kind: blueprint");
    expect(blueprint?.files.get("ralph.yaml")).toContain(
      "completeWhenSourceExhausted: true",
    );
    expect(blueprint?.files.has("BLUEPRINT.md")).toBe(true);
  });

  it("blueprint template owns the taskAppears trigger", () => {
    const blueprint = defaultExtensionRegistry.template("blueprint");
    expect(blueprint?.triggers?.map((trigger) => trigger.name)).toContain(
      "taskAppears",
    );
    expect(defaultExtensionRegistry.trigger("taskAppears")).toBeDefined();
    expect(defaultExtensionRegistry.template("goal")?.triggers).toBeUndefined();
  });

  it("blueprint template configures a taskAppears trigger watching BLUEPRINT.md", () => {
    const yaml =
      defaultExtensionRegistry.template("blueprint")?.files.get("ralph.yaml") ??
      "";
    expect(yaml).toContain("kind: taskAppears");
    expect(yaml).toContain("source: .agentic/BLUEPRINT.md");
    expect(yaml).toContain("pollInterval: 60s");
  });

  it("exposes goal in templates collection", () => {
    const names = defaultExtensionRegistry.templates.map((t) => t.name);
    expect(names).toContain("goal");
    expect(names).toContain("blueprint");
  });

  it("looks up template case-insensitively", () => {
    expect(defaultExtensionRegistry.template("GOAL")).toBeDefined();
    expect(defaultExtensionRegistry.template("Goal")).toBeDefined();
  });

  it("returns undefined for unknown template", () => {
    expect(defaultExtensionRegistry.template("unknown")).toBeUndefined();
  });
});

describe("acceptedExitCode predicate", () => {
  it("returns false when no check is configured", async () => {
    const result = await acceptedExitCodePredicate.callback({
      expand: (value) => value,
      runStage: async () => {
        throw new Error("runStage should not be called");
      },
    });

    expect(result).toBe(false);
  });

  it("returns the stage result when a check is configured", async () => {
    const check = { name: "check" } as never;
    await expect(
      acceptedExitCodePredicate.callback({
        check,
        expand: (value) => value,
        runStage: async () => ({ success: true }),
      }),
    ).resolves.toBe(true);
    await expect(
      acceptedExitCodePredicate.callback({
        check,
        expand: (value) => value,
        runStage: async () => ({ success: false }),
      }),
    ).resolves.toBe(false);
  });
});

describe("file predicates", () => {
  it("detect whether a file exists or is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-predicates-"));
    const path = join(directory, "present.txt");
    await writeFile(path, "present", "utf8");
    const context = {
      expand: (value: string) => value,
      runStage: async () => ({ success: true }),
    };

    await expect(
      fileExistsPredicate.callback({ ...context, path }),
    ).resolves.toBe(true);
    await expect(
      fileExistsPredicate.callback({
        ...context,
        path: join(directory, "missing"),
      }),
    ).resolves.toBe(false);
    await expect(
      fileMissingPredicate.callback({ ...context, path }),
    ).resolves.toBe(false);
    await expect(
      fileMissingPredicate.callback({
        ...context,
        path: join(directory, "missing"),
      }),
    ).resolves.toBe(true);
    await expect(fileExistsPredicate.callback({ ...context })).resolves.toBe(
      false,
    );
    await expect(fileMissingPredicate.callback({ ...context })).resolves.toBe(
      true,
    );

    await rm(directory, { recursive: true, force: true });
  });
});

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

describe("repeatedFailureSignature circuit breaker", () => {
  it("resets without a failure and identifies failed stages", async () => {
    const context = {
      expand: (value: string) => value,
      runStage: async () => ({ success: true }),
      kind: "repeatedFailureSignature",
      workspace: "",
      iteration: 1,
    };
    await expect(
      repeatedFailureSignatureCircuitBreaker.callback(context),
    ).resolves.toBeNull();
    await expect(
      repeatedFailureSignatureCircuitBreaker.callback({
        ...context,
        lastFailure: { stage: "build", exitCode: null },
      }),
    ).resolves.toBe("build:null");
    await expect(
      repeatedFailureSignatureCircuitBreaker.callback({
        ...context,
        lastFailure: { stage: "test", exitCode: 2 },
      }),
    ).resolves.toBe("test:2");
  });
});

describe("extension registry - built-in producers", () => {
  it("registers the goalProducer", () => {
    expect(defaultExtensionRegistry.producer("goalProducer")).toBeDefined();
  });

  it("goalProducer create() returns a CommandDto with sh and marker path", () => {
    const reg = defaultExtensionRegistry.producer("goalProducer");
    expect(reg).toBeDefined();
    if (!reg) return;
    const dto = reg.create();
    expect(dto.executable).toBe("sh");
    expect(Array.isArray(dto.arguments)).toBe(true);
    expect((dto.arguments as string[]).join(" ")).toContain(
      ".agentic/__remaining_failures.log",
    );
    expect(dto.timeout).toBe("15m");
    expect(dto.successExitCodes).toEqual([0]);
  });

  it("exposes goalProducer in producers collection", () => {
    const names = defaultExtensionRegistry.producers.map((p) => p.name);
    expect(names).toContain("goalProducer");
  });

  it("looks up producer case-insensitively", () => {
    expect(defaultExtensionRegistry.producer("GOALPRODUCER")).toBeDefined();
  });

  it("returns undefined for unknown producer", () => {
    expect(defaultExtensionRegistry.producer("unknown")).toBeUndefined();
  });
});

describe("extension registry - custom registrations", () => {
  it("merges custom templates with built-ins", () => {
    const registry = createExtensionRegistry({
      templates: [
        {
          name: "custom",
          files: new Map([["ralph.yaml", "schemaVersion: 1"]]),
        },
      ],
    });
    expect(registry.template("goal")).toBeDefined();
    expect(registry.template("custom")).toBeDefined();
    expect(registry.templates).toHaveLength(3);
  });

  it("merges custom producers with built-ins", () => {
    const registry = createExtensionRegistry({
      producers: [
        {
          name: "myProducer",
          create() {
            return { executable: "my-tool" };
          },
        },
      ],
    });
    expect(registry.producer("goalProducer")).toBeDefined();
    expect(registry.producer("myProducer")).toBeDefined();
    expect(registry.producers).toHaveLength(2);
  });

  it("rejects duplicate template name (case-insensitive) against built-in", () => {
    expect(() =>
      createExtensionRegistry({
        templates: [{ name: "GOAL", files: new Map() }],
      }),
    ).toThrow("Duplicate template: GOAL");
  });

  it("rejects duplicate producer name (case-insensitive) against built-in", () => {
    expect(() =>
      createExtensionRegistry({
        producers: [
          {
            name: "GOALPRODUCER",
            create() {
              return { executable: "x" };
            },
          },
        ],
      }),
    ).toThrow("Duplicate producer: GOALPRODUCER");
  });

  it("rejects blank template name", () => {
    expect(() =>
      createExtensionRegistry({
        templates: [{ name: "  ", files: new Map() }],
      }),
    ).toThrow("template name is required");
  });

  it("rejects blank producer name", () => {
    expect(() =>
      createExtensionRegistry({
        producers: [
          {
            name: "",
            create() {
              return { executable: "x" };
            },
          },
        ],
      }),
    ).toThrow("producer name is required");
  });
});
