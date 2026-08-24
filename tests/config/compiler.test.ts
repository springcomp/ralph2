import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkflowCompileError,
  compileWorkflow,
} from "../../src/config/compiler.js";
import type { V1WorkflowDocument } from "../../src/config/schema-v1.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";

describe("compileWorkflow", () => {
  const baseDoc: V1WorkflowDocument = {
    schemaVersion: 1,
    workspace: "work-dir",
    envFile: ".env",
    environment: [
      "GLOBAL={TASK}",
      { name: "GLOBAL2", value: "value", secret: false },
    ],
    maxIterations: 20,
    tasks: {
      prd: "tasks/PRD.md",
      progress: "tasks/progress.txt",
      prompt: "tasks/prompt.md",
      completionSignal: "<DONE>",
    },
    defaults: {
      harness: "pi",
      model: "test-model",
      agent: "test-agent",
      statusFormat: "Status: {TASK}",
    },
    harnesses: {
      pi: {
        executable: "pi",
        arguments: ["--model", "{MODEL}"],
        conditionalArguments: [
          {
            whenSet: "AGENT",
            arguments: ["--agent", "{AGENT}"],
          },
        ],
        environment: [
          { name: "API_KEY", value: "secret123", secret: true },
          { name: "DEBUG", value: "true", secret: false },
        ],
        envFile: ".agentic/harness.env",
        timeout: "15m",
        successExitCodes: [0, 1],
        output: { combined: ".agentic/out.log" },
        onFailure: {
          action: "scheduleTask",
          task: "Fix task",
        },
        failurePolicy: "continue",
      },
    },
    preAgent: [
      {
        name: "pre-step",
        executable: "node",
        arguments: ["pre.js"],
      },
    ],
    postAgent: [
      {
        executable: "node",
        arguments: ["post.js"],
        mandatory: false,
        result: { path: ".agentic/result.json", required: true },
      },
    ],
    verification: {
      requireTaskChecked: true,
      retries: 2,
      prompt: "Verify {TASK}",
    },
    continuation: {
      kind: "blueprint",
      source: "tasks/BLUEPRINT.md",
      seedPrdFromSource: true,
      completeWhenSourceExhausted: true,
    },
  };

  it("compiles a valid workflow document into a WorkflowPlan", () => {
    const configDir = resolve("/mock/project");
    const plan = compileWorkflow(baseDoc, configDir);

    expect(plan.workspace).toBe(resolve("/mock/project/work-dir"));
    expect(plan.envFilePath).toBe(resolve("/mock/project/work-dir/.env"));
    expect(plan.environment).toEqual([
      { name: "GLOBAL", value: "{TASK}", secret: false },
      { name: "GLOBAL2", value: "value", secret: false },
    ]);
    expect(plan.maxIterations).toBe(20);
    expect(plan.maxRemediationAttempts).toBe(2);
    expect(plan.defaultHarness).toBe("pi");
    expect(plan.model).toBe("test-model");
    expect(plan.agent).toBe("test-agent");
    expect(plan.tasks.prd).toBe(resolve("/mock/project/work-dir/tasks/PRD.md"));
    expect(plan.tasks.completionSignal).toBe("<DONE>");
    expect(plan.harnesses.pi).toBeDefined();
    expect(plan.harnesses.pi.timeoutMs).toBe(900000);
    expect(plan.harnesses.pi.successExitCodes).toEqual([0, 1]);
    expect(plan.harnesses.pi.failurePolicy).toBe("continue");
    expect(plan.harnesses.pi.failureTask).toBe("Fix task");
    expect(plan.harnesses.pi.environment).toEqual([
      { name: "API_KEY", value: "secret123", secret: true },
      { name: "DEBUG", value: "true", secret: false },
    ]);
    expect(plan.harnesses.pi.envFilePath).toBe(
      resolve("/mock/project/work-dir/.agentic/harness.env"),
    );
    expect(plan.preAgent).toHaveLength(1);
    expect(plan.preAgent[0].name).toBe("pre-step");
    expect(plan.postAgent).toHaveLength(1);
    expect(plan.postAgent[0].name).toBe("postAgent[0]");
    expect(plan.postAgent[0].mandatory).toBe(false);
    expect(plan.postAgent[0].resultPath).toBe(
      resolve("/mock/project/work-dir/.agentic/result.json"),
    );
    expect(plan.postAgent[0].resultRequired).toBe(true);
    expect(plan.verification.requireTaskChecked).toBe(true);
    expect(plan.verification.retries).toBe(2);
    expect(plan.verification.prompt).toBe("Verify {TASK}");
    expect(plan.continuation?.kind).toBe("blueprint");
    expect(plan.continuation?.seedPrdFromSource).toBe(true);
    expect(plan.continuation?.completeWhenSourceExhausted).toBe(true);
  });

  it("applies CompileOptions overrides", () => {
    const configDir = resolve("/mock/project");
    const plan = compileWorkflow(baseDoc, configDir, {
      workspace: "custom-workspace",
      maxIterations: 5,
      harness: "pi",
      model: "cli-model",
      agent: "cli-agent",
    });

    expect(plan.workspace).toBe(resolve("/mock/project/custom-workspace"));
    expect(plan.maxIterations).toBe(5);
    expect(plan.model).toBe("cli-model");
    expect(plan.agent).toBe("cli-agent");
  });

  it("resolves pty per-command with the CLI-level default as a fallback", () => {
    const configDir = resolve("/mock/project");
    const docWithPty: V1WorkflowDocument = {
      ...baseDoc,
      harnesses: {
        pi: { ...baseDoc.harnesses?.pi, pty: false },
        other: { executable: "other" },
      },
    };

    const plan = compileWorkflow(docWithPty, configDir, { pty: true });

    expect(plan.ptyDefault).toBe(true);
    expect(plan.harnesses.pi.pty).toBe(false);
    expect(plan.harnesses.other.pty).toBe(true);
  });

  it("compiles minimal workflow document with defaults and fallback values", () => {
    const minDoc: V1WorkflowDocument = {
      schemaVersion: 1,
      workspace: "min-workspace",
      maxIterations: 10,
      tasks: {
        prd: "PRD.md",
        progress: "progress.txt",
        prompt: "prompt.md",
      },
      defaults: {
        harness: "pi",
      },
      harnesses: {
        pi: {
          executable: "pi",
        },
      },
      verification: {
        requireTaskChecked: false,
      },
    };

    const plan = compileWorkflow(minDoc, "/base");
    expect(plan.workspace).toBe(resolve("/base/min-workspace"));
    expect(plan.model).toBeNull();
    expect(plan.agent).toBeNull();
    expect(plan.preAgent).toEqual([]);
    expect(plan.postAgent).toEqual([]);
    expect(plan.continuation).toBeUndefined();
    expect(plan.verification.requireTaskChecked).toBe(false);
    expect(plan.verification.retries).toBe(0);
    expect(plan.verification.prompt).toBeUndefined();
    expect(plan.statusFormat).toContain("Iteration");
    expect(plan.harnesses.pi.arguments).toEqual([]);
    expect(plan.harnesses.pi.conditionalArguments).toEqual([]);
    expect(plan.harnesses.pi.environment).toEqual([]);
    expect(plan.harnesses.pi.successExitCodes).toEqual([0]);
    expect(plan.harnesses.pi.outputPath).toBeUndefined();
    expect(plan.harnesses.pi.failureTask).toBeUndefined();
    expect(plan.harnesses.pi.failurePolicy).toBe("stop");
  });

  it("handles absolute paths in tasks and outputs", () => {
    const absPrd = resolve("/abs/tasks/PRD.md");
    const absOut = resolve("/abs/out.log");
    const doc: V1WorkflowDocument = {
      schemaVersion: 1,
      workspace: "work",
      maxIterations: 1,
      tasks: {
        prd: absPrd,
        progress: "progress.txt",
        prompt: "prompt.md",
      },
      defaults: {
        harness: "pi",
        model: "",
        agent: "",
      },
      harnesses: {
        pi: {
          executable: "pi",
          output: { combined: absOut },
          conditionalArguments: [
            { whenSet: "AGENT" } as unknown as {
              whenSet: string;
              arguments: string[];
            },
          ],
        },
      },
    };

    const plan = compileWorkflow(doc, "/base");
    expect(plan.tasks.prd).toBe(absPrd);
    expect(plan.harnesses.pi.outputPath).toBe(absOut);
    expect(plan.harnesses.pi.conditionalArguments[0].arguments).toEqual([]);
    expect(plan.model).toBeNull();
    expect(plan.agent).toBeNull();
  });

  it("compiles generatedGoal continuation with completeWhen without check", () => {
    const doc: V1WorkflowDocument = {
      ...baseDoc,
      continuation: {
        kind: "generatedGoal",
        nextTask: "- [ ] Fix goal",
        producer: {
          executable: "check.sh",
        },
        completeWhen: {
          kind: "fileMissing",
          path: "status.txt",
        },
      },
    };

    const plan = compileWorkflow(doc, "/mock/project");
    expect(plan.continuation?.kind).toBe("generatedGoal");
    expect(plan.continuation?.completeWhen?.check).toBeUndefined();
  });

  it("compiles a trigger and defaults its source to the PRD path", () => {
    const withTrigger: V1WorkflowDocument = {
      ...baseDoc,
      trigger: { kind: "taskAppears", pollInterval: "10s" },
    };
    const plan = compileWorkflow(withTrigger, "/mock/project");
    expect(plan.trigger?.kind).toBe("taskAppears");
    expect(plan.trigger?.pollIntervalMs).toBe(10000);
    expect(plan.trigger?.source).toBe(plan.tasks.prd);
  });

  it("compiles a trigger with an explicit source and default poll interval", () => {
    const withTrigger: V1WorkflowDocument = {
      ...baseDoc,
      trigger: { kind: "taskAppears", source: "tasks/BLUEPRINT.md" },
    };
    const plan = compileWorkflow(withTrigger, "/mock/project");
    expect(plan.trigger?.source).toBe(
      resolve("/mock/project/work-dir/tasks/BLUEPRINT.md"),
    );
    expect(plan.trigger?.pollIntervalMs).toBe(5000);
  });

  it("leaves trigger undefined when not configured", () => {
    const plan = compileWorkflow(baseDoc, "/mock/project");
    expect(plan.trigger).toBeUndefined();
  });

  it("compiles generatedGoal continuation with completeWhen including check", () => {
    const doc: V1WorkflowDocument = {
      ...baseDoc,
      continuation: {
        kind: "generatedGoal",
        nextTask: "- [ ] Fix goal",
        producer: {
          executable: "check.sh",
        },
        completeWhen: {
          kind: "customCheck",
          path: "status.txt",
          check: {
            executable: "eval.sh",
          },
        },
      },
    };

    const plan = compileWorkflow(doc, "/mock/project");
    expect(plan.continuation?.kind).toBe("generatedGoal");
    expect(plan.continuation?.completeWhen?.kind).toBe("customCheck");
    expect(plan.continuation?.completeWhen?.check?.name).toBe(
      "completion-check",
    );
  });

  it("throws WorkflowCompileError when document is invalid", () => {
    const invalidDoc = {
      ...baseDoc,
      schemaVersion: 99 as unknown as 1,
    };
    expect(() => compileWorkflow(invalidDoc, "/mock/project")).toThrow(
      WorkflowCompileError,
    );
  });

  it("compiles named producer string to the same StagePlan as inline command", () => {
    const inlineDoc: V1WorkflowDocument = {
      ...baseDoc,
      continuation: {
        kind: "generatedGoal",
        producer: {
          executable: "sh",
          arguments: ["-c", "test ! -e .agentic/__remaining_failures.log"],
          timeout: "15m",
          successExitCodes: [0],
        },
        completeWhen: { kind: "fileMissing", path: "marker.log" },
        nextTask: "- [ ] GOAL-{ITERATION:000} - Fix",
      },
    };
    const namedDoc: V1WorkflowDocument = {
      ...baseDoc,
      continuation: {
        kind: "generatedGoal",
        producer: "goalProducer",
        completeWhen: { kind: "fileMissing", path: "marker.log" },
        nextTask: "- [ ] GOAL-{ITERATION:000} - Fix",
      },
    };

    const inlinePlan = compileWorkflow(
      inlineDoc,
      "/mock/project",
      {},
      defaultExtensionRegistry,
    );
    const namedPlan = compileWorkflow(
      namedDoc,
      "/mock/project",
      {},
      defaultExtensionRegistry,
    );

    expect(namedPlan.continuation?.producer?.executable).toBe(
      inlinePlan.continuation?.producer?.executable,
    );
    expect(namedPlan.continuation?.producer?.arguments).toEqual(
      inlinePlan.continuation?.producer?.arguments,
    );
    expect(namedPlan.continuation?.producer?.timeoutMs).toBe(
      inlinePlan.continuation?.producer?.timeoutMs,
    );
    expect(namedPlan.continuation?.producer?.successExitCodes).toEqual(
      inlinePlan.continuation?.producer?.successExitCodes,
    );
  });
});
