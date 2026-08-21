#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { WorkflowCompileError, compileWorkflow } from "../config/compiler.js";
import { workflowSchemaYaml } from "../config/schema.js";
import {
  WorkflowValidationError,
  parseWorkflowYaml,
} from "../config/validator.js";
import { WorkflowEngine } from "../core/engine.js";
import { WorkflowExitCodes } from "../core/exit-codes.js";
import { RealProcessRunner } from "../core/process-runner.js";
import {
  type ActionRegistration,
  type ExtensionRegistration,
  type ExtensionRegistry,
  type PredicateRegistration,
  type ProducerRegistration,
  type TemplateRegistration,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
import { getTemplate, templates } from "../templates/template-registry.js";

export {
  createExtensionRegistry,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
export type {
  ExtensionProperty,
  ActionRegistration,
  PredicateRegistration,
  ExtensionRegistration,
  ExtensionRegistry,
  TemplateRegistration,
  ProducerRegistration,
} from "../extensions/registry.js";

interface CliOptions {
  config: string;
  model?: string;
  agent?: string;
  harness?: string;
  maxIterations?: number;
  workingDirectory?: string;
  plain?: boolean;
  pty?: boolean;
}

async function readConfig(
  path: string,
  options: CliOptions,
  extensions: ExtensionRegistry = defaultExtensionRegistry,
) {
  const text = await readFile(path, "utf8");
  const document = parseWorkflowYaml(text);
  return compileWorkflow(document, dirname(resolve(path)), options, extensions);
}

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = WorkflowExitCodes.InvalidConfiguration;
  throw error;
}

export function createProgram(
  extensions: ExtensionRegistry = defaultExtensionRegistry,
): Command {
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
      .option("--plain", "disable formatted status output")
      .option("--pty", "force-enable a pseudo-terminal for subprocess output")
      .option(
        "--no-pty",
        "force-disable pseudo-terminal (auto-detected by default)",
      );

  addWorkflowOptions(program.command("run")).action(
    async (options: CliOptions) => {
      try {
        const plan = await readConfig(options.config, options, extensions);
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
          extensions,
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

  const schema = program
    .command("schema")
    .argument("[show]", "show the workflow schema");
  schema.action(async (show: string | undefined) => {
    try {
      if (show && show !== "show") {
        console.error(`Unknown subcommand '${show}'.`);
        process.exitCode = WorkflowExitCodes.InvalidConfiguration;
        return;
      }
      console.log(workflowSchemaYaml(extensions));
      process.exitCode = WorkflowExitCodes.Complete;
    } catch (error) {
      process.exitCode = WorkflowExitCodes.InvalidConfiguration;
      console.error(error instanceof Error ? error.message : String(error));
    }
  });

  schema
    .command("validate")
    .requiredOption("--config <path>", "workflow YAML path")
    .action(async (options: CliOptions) => {
      try {
        await readConfig(options.config, options, extensions);
        console.log("Configuration is valid.");
        process.exitCode = WorkflowExitCodes.Complete;
      } catch (error) {
        process.exitCode =
          error instanceof WorkflowCompileError ||
          error instanceof WorkflowValidationError
            ? WorkflowExitCodes.InvalidConfiguration
            : WorkflowExitCodes.ProcessFailure;
        console.error(error instanceof Error ? error.message : String(error));
      }
    });

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
        const registered = extensions.template(options.template);
        const legacyTemplate = !registered
          ? getTemplate(options.template)
          : undefined;
        if (!registered && !legacyTemplate) {
          process.exitCode = WorkflowExitCodes.InvalidConfiguration;
          console.error("Unknown template.");
          return;
        }
        const entries: Iterable<[string, string]> = registered
          ? registered.files
          : Object.entries(legacyTemplate ?? {});
        const root = resolve(options.workingDirectory);
        const target = resolve(root, ".agentic");
        try {
          await mkdir(target, { recursive: true });
          for (const [name, content] of entries) {
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

  const addShowCommand = (
    name: string,
    output: () => void,
    aliases: string[] = [],
  ) => {
    const command = program
      .command(name)
      .argument("[show]", "show this information")
      .action((show?: string) => {
        if (show && show !== "show") {
          console.error(`Unknown subcommand '${show}'.`);
          process.exitCode = WorkflowExitCodes.InvalidConfiguration;
          return;
        }
        output();
      });
    for (const alias of aliases) command.alias(alias);
    return command;
  };

  addShowCommand("templates", () => {
    const registeredNames = new Set(
      extensions.templates.map((t) => t.name.toLowerCase()),
    );
    const legacyNames = Object.keys(templates).filter(
      (n) => !registeredNames.has(n.toLowerCase()),
    );
    console.log(
      [...extensions.templates.map((t) => t.name), ...legacyNames].join("\n"),
    );
  });
  addShowCommand(
    "variables",
    () => {
      console.log(
        "MODEL\nAGENT\nTYP\nNUM\nTASK\nTASK_LINE\nPROMPT\nPRD\nPROGRESS\nITERATION\nITERATION:000\nWORKSPACE",
      );
    },
    ["vars"],
  );
  addShowCommand("actions", () => {
    console.log(extensions.actions.map((x) => x.name).join("\n"));
  });
  addShowCommand("predicates", () => {
    console.log(extensions.predicates.map((x) => x.name).join("\n"));
  });

  const explain = program.command("explain");
  const addExtensionCommand = (kind: "action" | "predicate") => {
    const command = explain
      .command(kind)
      .argument("<name>")
      .action((name: string) => {
        const registration =
          kind === "action"
            ? extensions.action(name)
            : extensions.predicate(name);
        if (!registration) {
          console.error(`Unknown ${kind} '${name}'.`);
          process.exitCode = WorkflowExitCodes.InvalidConfiguration;
          return;
        }
        console.log(formatExtensionHelp(kind, registration));
      });
    return command;
  };

  addExtensionCommand("action");
  addExtensionCommand("predicate");
  return program;
}

function formatExtensionHelp(
  kind: string,
  registration: ExtensionRegistration,
): string {
  const properties = registration.properties.length
    ? registration.properties
        .map(
          (property) =>
            `  ${property.name}${property.required ? " (required)" : ""}: ${property.description}`,
        )
        .join("\n")
    : "  (none)";
  return `${kind}: ${registration.name}\n${registration.description}\nproperties:\n${properties}`;
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
