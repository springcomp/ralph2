import { describe, expect, it } from "vitest";
import {
  createExtensionRegistry,
  defaultExtensionRegistry,
} from "../../src/extensions/registry.js";
import { acceptedExitCodePredicate } from "../../src/extensions/predicates/accepted-exit-code.js";

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
    expect(reg?.files.get("PRD.md")).toBeDefined();
    expect(reg?.files.get("progress.txt")).toBeDefined();
  });

  it("goal template yaml contains fileMissing, marker path, timeout, and nextTask", () => {
    const yaml =
      defaultExtensionRegistry.template("goal")?.files.get("ralph.yaml") ?? "";
    expect(yaml).toContain("fileMissing");
    expect(yaml).toContain(".agentic/__remaining_failures.log");
    expect(yaml).toContain("15m");
    expect(yaml).toContain("GOAL-{ITERATION:000}");
  });

  it("blueprint template reuses goal files and configures source seeding", () => {
    const goal = defaultExtensionRegistry.template("goal");
    const blueprint = defaultExtensionRegistry.template("blueprint");
    expect(blueprint?.files.get("ralph.prompt.md")).not.toBe(
      goal?.files.get("ralph.prompt.md"),
    );
    expect(blueprint?.files.get("ralph.prompt.md")).toContain("{PRD}");
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
      kind: "acceptedExitCode",
      runStage: async () => {
        throw new Error("runStage should not be called");
      },
    });

    expect(result).toBe(false);
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
