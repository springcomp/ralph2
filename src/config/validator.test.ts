import { describe, expect, it } from "vitest";
import type { V1WorkflowDocument } from "./schema-v1.js";
import {
  WorkflowValidationError,
  parseTimeout,
  parseWorkflowYaml,
  validateWorkflow,
} from "./validator.js";

describe("parseWorkflowYaml", () => {
  it("parses valid workflow yaml mapping", () => {
    const yaml = `
schemaVersion: 1
workspace: .
maxIterations: 10
tasks:
  prd: .agentic/PRD.md
  progress: .agentic/progress.txt
  prompt: .agentic/ralph.prompt.md
defaults:
  harness: pi
harnesses:
  pi:
    executable: pi
`;
    const doc = parseWorkflowYaml(yaml);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.tasks?.prd).toBe(".agentic/PRD.md");
  });

  it("throws WorkflowValidationError on invalid YAML syntax", () => {
    expect(() => parseWorkflowYaml("invalid: [yaml: foo")).toThrow(
      WorkflowValidationError,
    );
  });

  it("throws WorkflowValidationError on non-mapping documents", () => {
    expect(() => parseWorkflowYaml("hello world")).toThrow(
      WorkflowValidationError,
    );
    expect(() => parseWorkflowYaml("- item 1\n- item 2")).toThrow(
      WorkflowValidationError,
    );
    expect(() => parseWorkflowYaml("")).toThrow(WorkflowValidationError);
  });
});

describe("parseTimeout", () => {
  it("returns default 300000ms (5m) when value is undefined, null, or empty string", () => {
    expect(parseTimeout(undefined)).toBe(300000);
    expect(parseTimeout(null)).toBe(300000);
    expect(parseTimeout("")).toBe(300000);
  });

  it("parses time unit strings accurately", () => {
    expect(parseTimeout("30s")).toBe(30000);
    expect(parseTimeout("1.5s")).toBe(1500);
    expect(parseTimeout("5m")).toBe(300000);
    expect(parseTimeout("2h")).toBe(7200000);
  });

  it("parses numeric strings as milliseconds", () => {
    expect(parseTimeout("5000")).toBe(5000);
  });

  it("returns 0 for invalid or negative strings / values", () => {
    expect(parseTimeout("invalid")).toBe(0);
    expect(parseTimeout("-10s")).toBe(0);
    expect(parseTimeout(-5)).toBe(0);
    expect(parseTimeout({})).toBe(0);
  });
});

describe("validateWorkflow", () => {
  const validBaseDoc = {
    schemaVersion: 1,
    workspace: "..",
    maxIterations: 50,
    tasks: {
      prd: ".agentic/PRD.md",
      progress: ".agentic/progress.txt",
      prompt: ".agentic/ralph.prompt.md",
    },
    defaults: {
      harness: "pi",
      statusFormat: "Running iteration {ITERATION}",
    },
    harnesses: {
      pi: {
        executable: "pi",
        arguments: ["--model", "{MODEL}", "--prompt", "{PROMPT}"],
        conditionalArguments: [
          {
            whenSet: "AGENT",
            arguments: ["--agent", "{AGENT}"],
          },
        ],
        environment: [
          {
            name: "ENV_VAR",
            value: "{WORKSPACE}/log",
          },
        ],
        timeout: "10m",
        onFailure: {
          action: "scheduleTask" as const,
          task: "Fix failure",
        },
      },
    },
  };

  it("produces no diagnostics for a valid workflow document", () => {
    const diagnostics = validateWorkflow(validBaseDoc);
    expect(diagnostics).toHaveLength(0);
  });

  it("validates valid blueprint continuation", () => {
    const doc = {
      ...validBaseDoc,
      continuation: {
        kind: "blueprint",
        source: ".agentic/BLUEPRINT.md",
      },
    };
    expect(validateWorkflow(doc)).toHaveLength(0);
  });

  it("validates valid generatedGoal continuation", () => {
    const doc = {
      ...validBaseDoc,
      continuation: {
        kind: "generatedGoal",
        producer: {
          executable: "sh",
          arguments: ["-c", "test ! -e log"],
        },
        completeWhen: {
          kind: "fileMissing",
        },
        nextTask: "- [ ] GOAL-{ITERATION:000} - Fix remaining",
      },
    };
    expect(validateWorkflow(doc)).toHaveLength(0);
  });

  it("collects diagnostics for invalid schema version, workspace, maxIterations, and tasks", () => {
    const doc = {
      schemaVersion: 2,
      workspace: "",
      maxIterations: -1,
      tasks: {},
      defaults: {
        harness: "nonexistent",
      },
      harnesses: {},
    } as unknown as V1WorkflowDocument;

    const diagnostics = validateWorkflow(doc);
    const paths = diagnostics.map((d) => d.path);
    expect(paths).toContain("schemaVersion");
    expect(paths).toContain("workspace");
    expect(paths).toContain("maxIterations");
    expect(paths).toContain("tasks.prd");
    expect(paths).toContain("tasks.progress");
    expect(paths).toContain("tasks.prompt");
    expect(paths).toContain("defaults.harness");
    expect(paths).toContain("harnesses");
  });

  it("diagnoses missing defaults or harnesses object completely", () => {
    const doc = {
      schemaVersion: 1,
      workspace: ".",
      maxIterations: 10,
    } as unknown as V1WorkflowDocument;
    const diagnostics = validateWorkflow(doc);
    const paths = diagnostics.map((d) => d.path);
    expect(paths).toContain("tasks");
    expect(paths).toContain("defaults");
    expect(paths).toContain("harnesses");
  });

  it("collects diagnostics for invalid command definitions in harnesses, preAgent, and postAgent", () => {
    const doc = {
      ...validBaseDoc,
      preAgent: [
        "not an object" as unknown,
        {
          executable: "",
          arguments: ["valid", 123 as unknown as string, "{UNKNOWN_TOKEN}"],
          timeout: "invalid",
          conditionalArguments: [
            { whenSet: "" },
            { whenSet: "UNKNOWN_COND", arguments: ["{BAD_TOKEN}"] },
          ],
          environment: [
            { name: "", value: "val" },
            { name: "ok", value: 123 as unknown as string },
            { name: "ok2", value: "{INVALID_PH}" },
          ],
          onFailure: {
            action: "invalidAction" as unknown as "scheduleTask",
            task: "",
          },
        },
      ],
      postAgent: [
        {
          executable: "echo",
          conditionalArguments: "not-array" as unknown as [],
          environment: "not-array" as unknown as [],
        },
      ],
    } as unknown as V1WorkflowDocument;

    const diagnostics = validateWorkflow(doc);
    expect(diagnostics.length).toBeGreaterThan(0);
    const paths = diagnostics.map((d) => d.path);
    expect(paths).toContain("preAgent[0]");
    expect(paths).toContain("preAgent[1].executable");
    expect(paths).toContain("preAgent[1].arguments");
    expect(paths).toContain("preAgent[1].arguments[2]");
    expect(paths).toContain("preAgent[1].timeout");
    expect(paths).toContain("preAgent[1].conditionalArguments[0].whenSet");
    expect(paths).toContain("preAgent[1].conditionalArguments[1].whenSet");
    expect(paths).toContain("preAgent[1].conditionalArguments[1].arguments[0]");
    expect(paths).toContain("preAgent[1].environment[0].name");
    expect(paths).toContain("preAgent[1].environment[1].value");
    expect(paths).toContain("preAgent[1].environment[2].value[0]");
    expect(paths).toContain("preAgent[1].onFailure.action");
    expect(paths).toContain("preAgent[1].onFailure.task");
    expect(paths).toContain("postAgent[0].conditionalArguments");
    expect(paths).toContain("postAgent[0].environment");
  });

  it("collects diagnostics for invalid continuation configurations", () => {
    const doc1 = {
      ...validBaseDoc,
      continuation: {
        kind: "invalidKind",
      },
    };
    expect(validateWorkflow(doc1).map((d) => d.path)).toContain(
      "continuation.kind",
    );

    const doc2 = {
      ...validBaseDoc,
      continuation: {
        kind: "blueprint",
        source: "",
      },
    };
    expect(validateWorkflow(doc2).map((d) => d.path)).toContain(
      "continuation.source",
    );

    const doc3 = {
      ...validBaseDoc,
      continuation: {
        kind: "generatedGoal",
      },
    };
    const doc3Paths = validateWorkflow(doc3).map((d) => d.path);
    expect(doc3Paths).toContain("continuation.producer");
    expect(doc3Paths).toContain("continuation.completeWhen");
    expect(doc3Paths).toContain("continuation.nextTask");

    const doc4 = {
      ...validBaseDoc,
      continuation: {
        kind: "generatedGoal",
        producer: { executable: "echo" },
        completeWhen: { kind: "fileMissing" },
        nextTask: "Invalid {BAD_PLACEHOLDER}",
      },
    };
    expect(validateWorkflow(doc4).map((d) => d.path)).toContain(
      "continuation.nextTask[0]",
    );
  });

  it("checks defaults statusFormat for invalid placeholders", () => {
    const doc = {
      ...validBaseDoc,
      defaults: {
        ...validBaseDoc.defaults,
        statusFormat: "Hello {INVALID_TOKEN}",
      },
    };
    expect(validateWorkflow(doc).map((d) => d.path)).toContain(
      "defaults.statusFormat[0]",
    );
  });
});
