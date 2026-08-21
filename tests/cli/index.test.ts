import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/index.js";
import type { WorkflowPlan } from "../../src/config/compiler.js";
import type { WorkflowEngineCallbacks } from "../../src/core/engine.js";
import { WorkflowExitCodes } from "../../src/core/exit-codes.js";
import { createExtensionRegistry } from "../../src/extensions/registry.js";

vi.mock("../../src/core/engine.js", () => {
  return {
    WorkflowEngine: class MockWorkflowEngine {
      callbacks?: WorkflowEngineCallbacks;
      constructor(
        _runner: unknown,
        _p: unknown,
        _s: unknown,
        callbacks?: WorkflowEngineCallbacks,
      ) {
        this.callbacks = callbacks;
      }
      async run(_plan: WorkflowPlan, options: { plain?: boolean }) {
        if (!options.plain) {
          if (this.callbacks?.onStatus) {
            await this.callbacks.onStatus("Running task 1");
          }
          if (this.callbacks?.onEvent) {
            await this.callbacks.onEvent({
              type: "stage",
              iteration: 1,
              message: "preAgent done",
            });
          }
        }
        return {
          status: "complete",
          message: "All tasks completed",
          iterations: 1,
          events: [],
          exitCode: WorkflowExitCodes.Complete,
        };
      }
    },
  };
});

describe("CLI Application", () => {
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ralph-cli-test-"));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  describe("introspection commands", () => {
    it.each([["templates"], ["templates", "show"]])(
      "lists available templates with %s",
      async (...args) => {
        await createProgram().parseAsync(["node", "ralph", ...args]);
        expect(consoleLogSpy).toHaveBeenCalledWith("goal\nblueprint");
      },
    );

    it.each([["variables"], ["variables", "show"], ["vars"], ["vars", "show"]])(
      "lists supported variables with %s",
      async (...args) => {
        await createProgram().parseAsync(["node", "ralph", ...args]);
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("MODEL"),
        );
      },
    );

    it.each([["actions"], ["actions", "show"]])(
      "lists registered actions with %s",
      async (...args) => {
        await createProgram().parseAsync(["node", "ralph", ...args]);
        expect(consoleLogSpy).toHaveBeenCalledWith("scheduleTask");
      },
    );

    it.each([["predicates"], ["predicates", "show"]])(
      "lists registered predicates with %s",
      async (...args) => {
        await createProgram().parseAsync(["node", "ralph", ...args]);
        expect(consoleLogSpy).toHaveBeenCalledWith(
          "fileExists\nfileMissing\nacceptedExitCode",
        );
      },
    );

    it("shows action documentation with explain", async () => {
      const args = ["explain", "action", "scheduleTask"];
      await createProgram().parseAsync(["node", "ralph", ...args]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("action: scheduleTask"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("task"),
      );
    });

    it("shows predicate documentation with explain", async () => {
      const args = ["explain", "predicate", "fileMissing"];
      await createProgram().parseAsync(["node", "ralph", ...args]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("predicate: fileMissing"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("path"),
      );
    });

    it("rejects an unknown promoted subcommand", async () => {
      await createProgram().parseAsync(["node", "ralph", "templates", "list"]);
      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Unknown subcommand 'list'.",
      );
    });
  });

  describe("init command", () => {
    it("initializes goal template in .agentic directory", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        tmpDir,
      ]);

      const yaml = await readFile(
        join(tmpDir, ".agentic", "ralph.yaml"),
        "utf8",
      );
      expect(yaml).toContain("generatedGoal");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Initialized goal workflow"),
      );
    });

    it("initializes blueprint template in .agentic directory", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "blueprint",
        "--working-directory",
        tmpDir,
      ]);

      const yaml = await readFile(
        join(tmpDir, ".agentic", "ralph.yaml"),
        "utf8",
      );
      expect(yaml).toContain("blueprint");
    });

    it("fails without --force if files already exist", async () => {
      const program1 = createProgram();
      await program1.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        tmpDir,
      ]);

      const program2 = createProgram();
      await program2.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        tmpDir,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to overwrite"),
      );
    });

    it("overwrites files when --force is provided", async () => {
      const program1 = createProgram();
      await program1.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        tmpDir,
      ]);

      const program2 = createProgram();
      await program2.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        tmpDir,
        "--force",
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Initialized goal workflow"),
      );
    });

    it("fails when unknown template is specified", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "nonexistent",
        "--working-directory",
        tmpDir,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Unknown template.");
    });

    it("handles unexpected filesystem errors during init", async () => {
      // Writing to a file path as directory will cause mkdir to fail
      const filePath = join(tmpDir, "file-blocking-dir");
      await writeFile(filePath, "content", "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "goal",
        "--working-directory",
        filePath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe("schema validation command", () => {
    it("validates valid workflow yaml successfully", async () => {
      const configPath = join(tmpDir, "ralph.yaml");
      const yamlContent = `
schemaVersion: 1
workspace: .
maxIterations: 10
tasks:
  prd: PRD.md
  progress: progress.txt
  prompt: prompt.md
defaults:
  harness: pi
harnesses:
  pi:
    executable: pi
`;
      await writeFile(configPath, yamlContent, "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "schema",
        "validate",
        "--config",
        configPath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.Complete);
      expect(consoleLogSpy).toHaveBeenCalledWith("Configuration is valid.");
    });

    it("fails validation for invalid configuration", async () => {
      const configPath = join(tmpDir, "invalid.yaml");
      await writeFile(configPath, "invalid: [yaml", "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "schema",
        "validate",
        "--config",
        configPath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it.each([["schema"], ["schema", "show"]])(
      "shows the workflow schema with %s",
      async (...args) => {
        await createProgram().parseAsync(["node", "ralph", ...args]);
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("$schema:"),
        );
      },
    );
  });

  describe("run command", () => {
    it("runs workflow successfully with formatted status", async () => {
      const configPath = join(tmpDir, "valid.yaml");
      const yamlContent = `
schemaVersion: 1
workspace: .
maxIterations: 10
tasks:
  prd: PRD.md
  progress: progress.txt
  prompt: prompt.md
defaults:
  harness: pi
harnesses:
  pi:
    executable: pi
`;
      await writeFile(configPath, yamlContent, "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "run",
        "--config",
        configPath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.Complete);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Running task 1");
      expect(consoleErrorSpy).toHaveBeenCalledWith("[stage] preAgent done");
    });

    it("runs workflow with --plain flag disabling callbacks", async () => {
      const configPath = join(tmpDir, "valid.yaml");
      const yamlContent = `
schemaVersion: 1
workspace: .
maxIterations: 10
tasks:
  prd: PRD.md
  progress: progress.txt
  prompt: prompt.md
defaults:
  harness: pi
harnesses:
  pi:
    executable: pi
`;
      await writeFile(configPath, yamlContent, "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "run",
        "--config",
        configPath,
        "--plain",
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.Complete);
    });

    it("fails when configuration file does not exist", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "run",
        "--config",
        join(tmpDir, "nonexistent.yaml"),
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.ProcessFailure);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("fails when configuration YAML is invalid", async () => {
      const configPath = join(tmpDir, "bad.yaml");
      await writeFile(configPath, "invalid: [yaml", "utf8");

      const program = createProgram();
      await program.parseAsync([
        "node",
        "ralph",
        "run",
        "--config",
        configPath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe("custom extension registry templates", () => {
    it("lists custom template alongside built-ins and blueprint", async () => {
      const registry = createExtensionRegistry({
        templates: [
          {
            name: "custom",
            files: new Map([["ralph.yaml", "schemaVersion: 1"]]),
          },
        ],
      });
      await createProgram(registry).parseAsync(["node", "ralph", "templates"]);
      const output = (consoleLogSpy.mock.calls[0]?.[0] as string) ?? "";
      expect(output).toContain("goal");
      expect(output).toContain("custom");
      expect(output).toContain("blueprint");
    });

    it("initializes a custom registered template", async () => {
      const registry = createExtensionRegistry({
        templates: [
          {
            name: "custom",
            files: new Map([
              ["ralph.yaml", "schemaVersion: 1\n# custom template\n"],
            ]),
          },
        ],
      });
      await createProgram(registry).parseAsync([
        "node",
        "ralph",
        "init",
        "--template",
        "custom",
        "--working-directory",
        tmpDir,
      ]);
      const yaml = await readFile(
        join(tmpDir, ".agentic", "ralph.yaml"),
        "utf8",
      );
      expect(yaml).toContain("custom template");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Initialized custom workflow"),
      );
    });
  });
});
