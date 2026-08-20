import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowPlan } from "../config/compiler.js";
import type { WorkflowEngineCallbacks } from "../core/engine.js";
import { WorkflowExitCodes } from "../core/exit-codes.js";
import { createProgram } from "./index.js";

vi.mock("../core/engine.js", () => {
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

  describe("show command", () => {
    it("lists available templates with --templates", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "ralph", "show", "--templates"]);
      expect(consoleLogSpy).toHaveBeenCalledWith("goal\nblueprint");
    });

    it("lists supported variables with --variables or --vars", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "ralph", "show", "--variables"]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("MODEL"),
      );

      consoleLogSpy.mockClear();
      await program.parseAsync(["node", "ralph", "show", "--vars"]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("TASK"),
      );
    });

    it("shows help when no options are provided to show", async () => {
      const program = createProgram();
      const showCommand = program.commands.find((c) => c.name() === "show");
      expect(showCommand).toBeDefined();
      if (showCommand) {
        const helpSpy = vi
          .spyOn(showCommand, "help")
          .mockImplementation(() => undefined as never);
        await program.parseAsync(["node", "ralph", "show"]);
        expect(helpSpy).toHaveBeenCalled();
      }
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

  describe("validate command", () => {
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
        "validate",
        "--config",
        configPath,
      ]);

      expect(process.exitCode).toBe(WorkflowExitCodes.InvalidConfiguration);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
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
});
