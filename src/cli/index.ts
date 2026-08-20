#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { WorkflowCompileError, compileWorkflow } from "../config/compiler.js";
import {
  WorkflowValidationError,
  parseWorkflowYaml,
} from "../config/validator.js";
import { WorkflowEngine } from "../core/engine.js";
import { WorkflowExitCodes } from "../core/exit-codes.js";
import { RealProcessRunner } from "../core/process-runner.js";
import { getTemplate, templates } from "../templates/template-registry.js";

interface CliOptions {
  config: string;
  model?: string;
  agent?: string;
  harness?: string;
  maxIterations?: number;
  workingDirectory?: string;
  plain?: boolean;
}

async function readConfig(path: string, options: CliOptions) {
  const text = await readFile(path, "utf8");
  const document = parseWorkflowYaml(text);
  return compileWorkflow(document, dirname(resolve(path)), options);
}

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = WorkflowExitCodes.InvalidConfiguration;
  throw error;
}

export function createProgram(): Command {
  const program = new Command()
    .name("ralph")
    .description("A deterministic AI coding loop orchestrator.");
  const addWorkflowOptions = (command: Command) =>
    command
      .requiredOption("--config <path>", "workflow YAML path")
      .option("--model <model>")
      .option("--agent <agent>")
      .option("--harness <name>")
      .option("--max-iterations <n>", "maximum iterations", (value) =>
        Number(value),
      )
      .option("--working-directory <path>")
      .option("--plain", "disable formatted status output");

  addWorkflowOptions(program.command("run")).action(
    async (options: CliOptions) => {
      try {
        const plan = await readConfig(options.config, options);
        const engine = new WorkflowEngine(
          new RealProcessRunner(),
          undefined,
          undefined,
          {
            onStatus: options.plain
              ? undefined
              : (status) => console.error(status),
            onEvent: options.plain
              ? undefined
              : (event) => console.error(`[${event.type}] ${event.message}`),
          },
        );
        const result = await engine.run(plan, options);
        if (result.message) {
          if (result.exitCode === WorkflowExitCodes.Complete) {
            console.log(result.message);
          } else {
            console.error(result.message);
          }
        }
        process.exitCode = result.exitCode;
      } catch (error) {
        process.exitCode =
          error instanceof WorkflowCompileError ||
          error instanceof WorkflowValidationError
            ? WorkflowExitCodes.InvalidConfiguration
            : WorkflowExitCodes.ProcessFailure;
        console.error(error instanceof Error ? error.message : String(error));
      }
    },
  );

  addWorkflowOptions(program.command("validate")).action(
    async (options: CliOptions) => {
      try {
        await readConfig(options.config, options);
        console.log("Configuration is valid.");
        process.exitCode = WorkflowExitCodes.Complete;
      } catch (error) {
        process.exitCode = WorkflowExitCodes.InvalidConfiguration;
        console.error(error instanceof Error ? error.message : String(error));
      }
    },
  );

  program
    .command("init")
    .requiredOption("--template <goal|blueprint>")
    .option("--working-directory <path>", "target workspace", process.cwd())
    .option("--force")
    .action(
      async (options: {
        template: string;
        workingDirectory: string;
        force?: boolean;
      }) => {
        const template = getTemplate(options.template);
        if (!template) {
          process.exitCode = WorkflowExitCodes.InvalidConfiguration;
          console.error("Unknown template.");
          return;
        }
        const root = resolve(options.workingDirectory);
        const target = resolve(root, ".agentic");
        try {
          await mkdir(target, { recursive: true });
          for (const [name, content] of Object.entries(template)) {
            const path = resolve(target, name);
            if (!options.force) {
              try {
                await access(path);
                console.error(`Refusing to overwrite ${path}. Use --force.`);
                process.exitCode = WorkflowExitCodes.InvalidConfiguration;
                return;
              } catch {}
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, "utf8");
          }
          console.log(`Initialized ${options.template} workflow in ${target}.`);
        } catch (error) {
          process.exitCode = WorkflowExitCodes.ProcessFailure;
          console.error(error instanceof Error ? error.message : String(error));
        }
      },
    );

  const show = program.command("show");
  show
    .option("--variables")
    .option("--vars")
    .option("--templates")
    .action(
      (options: {
        variables?: boolean;
        vars?: boolean;
        templates?: boolean;
      }) => {
        if (options.templates) {
          console.log(Object.keys(templates).join("\n"));
          return;
        }
        if (options.variables || options.vars) {
          console.log(
            "MODEL\nAGENT\nTYP\nNUM\nTASK\nTASK_LINE\nPROMPT\nPRD\nPROGRESS\nITERATION\nITERATION:000\nWORKSPACE",
          );
          return;
        }
        show.help();
      },
    );
  return program;
}

if (
  process.argv[1]?.endsWith("/cli/index.js") ||
  process.argv[1]?.endsWith("\\cli\\index.js")
) {
  createProgram()
    .parseAsync()
    .catch(() => {
      process.exitCode ??= WorkflowExitCodes.ProcessFailure;
    });
}
