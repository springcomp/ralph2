import { isAbsolute, normalize, resolve } from "node:path";
import type { CommandDto, V1WorkflowDocument } from "./schema-v1.js";
import {
  type Diagnostic,
  parseTimeout,
  validateWorkflow,
} from "./validator.js";

export interface CompileOptions {
  workingDirectory?: string;
  workspace?: string;
  maxIterations?: number;
  harness?: string;
  model?: string | null;
  agent?: string | null;
}
export interface EnvironmentVariablePlan {
  name: string;
  value: string;
  secret: boolean;
}
export interface StagePlan {
  name: string;
  executable: string;
  arguments: string[];
  conditionalArguments: { whenSet: string; arguments: string[] }[];
  environment: EnvironmentVariablePlan[];
  timeoutMs: number;
  successExitCodes: number[];
  outputPath?: string;
  failureTask?: string;
  failurePolicy: "stop" | "continue";
}
export interface TaskFileSet {
  prd: string;
  progress: string;
  prompt: string;
  completionSignal: string;
}
export interface WorkflowPlan {
  workspace: string;
  maxIterations: number;
  tasks: TaskFileSet;
  harnesses: Record<string, StagePlan>;
  defaultHarness: string;
  model: string | null;
  agent: string | null;
  preAgent: StagePlan[];
  postAgent: StagePlan[];
  verification: {
    requireTaskChecked: boolean;
    retries: number;
    prompt?: string;
  };
  continuation?: {
    kind: string;
    source?: string;
    seedPrdFromSource: boolean;
    completeWhenSourceExhausted: boolean;
    nextTask?: string;
  };
  statusFormat: string;
}
export class WorkflowCompileError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  }
}
const text = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const path = (workspace: string, value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : normalize(
        isAbsolute(text(value)) ? text(value) : resolve(workspace, text(value)),
      );
function stage(name: string, dto: CommandDto, workspace: string): StagePlan {
  return {
    name,
    executable: text(dto.executable),
    arguments: Array.isArray(dto.arguments)
      ? [...dto.arguments].map(String)
      : [],
    conditionalArguments: Array.isArray(dto.conditionalArguments)
      ? dto.conditionalArguments.map((g) => ({
          whenSet: text(g.whenSet),
          arguments: Array.isArray(g.arguments)
            ? [...g.arguments].map(String)
            : [],
        }))
      : [],
    environment: Array.isArray(dto.environment)
      ? dto.environment.map((e) => ({
          name: text(e.name),
          value: text(e.value),
          secret: e.secret === true,
        }))
      : [],
    timeoutMs: parseTimeout(dto.timeout),
    successExitCodes:
      Array.isArray(dto.successExitCodes) && dto.successExitCodes.length
        ? [...dto.successExitCodes].map(Number)
        : [0],
    outputPath: path(workspace, dto.output?.combined),
    failureTask: text(dto.onFailure?.task) || undefined,
    failurePolicy: dto.failurePolicy === "continue" ? "continue" : "stop",
  };
}
export function compileWorkflow(
  document: V1WorkflowDocument,
  configDirectory: string,
  options: CompileOptions = {},
): WorkflowPlan {
  const diagnostics = validateWorkflow(document);
  if (diagnostics.length) throw new WorkflowCompileError(diagnostics);
  const workspace = normalize(
    resolve(
      options.workingDirectory ?? configDirectory,
      options.workspace ?? text(document.workspace),
    ),
  );
  const tasks = document.tasks;
  const defaults = document.defaults;
  const configuredHarnesses = document.harnesses;
  if (!tasks || !defaults || !configuredHarnesses) {
    throw new WorkflowCompileError([
      { path: "$", message: "invalid workflow document" },
    ]);
  }
  const harnesses = Object.fromEntries(
    Object.entries(configuredHarnesses).map(([name, dto]) => [
      name,
      stage(name, dto, workspace),
    ]),
  );
  const continuation = document.continuation
    ? {
        kind: text(document.continuation.kind),
        source: path(workspace, document.continuation.source),
        seedPrdFromSource: document.continuation.seedPrdFromSource === true,
        completeWhenSourceExhausted:
          document.continuation.completeWhenSourceExhausted === true,
        nextTask: text(document.continuation.nextTask) || undefined,
      }
    : undefined;
  return {
    workspace,
    maxIterations: options.maxIterations ?? Number(document.maxIterations),
    tasks: {
      prd: path(workspace, tasks.prd) ?? "",
      progress: path(workspace, tasks.progress) ?? "",
      prompt: path(workspace, tasks.prompt) ?? "",
      completionSignal: text(tasks.completionSignal),
    },
    harnesses,
    defaultHarness: options.harness ?? text(defaults.harness),
    model:
      options.model !== undefined
        ? options.model
        : text(defaults.model) || null,
    agent:
      options.agent !== undefined
        ? options.agent
        : text(defaults.agent) || null,
    preAgent: (document.preAgent ?? []).map((x, i) =>
      stage(x.name ? text(x.name) : `preAgent[${i}]`, x, workspace),
    ),
    postAgent: (document.postAgent ?? []).map((x, i) =>
      stage(x.name ? text(x.name) : `postAgent[${i}]`, x, workspace),
    ),
    verification: {
      requireTaskChecked: document.verification?.requireTaskChecked !== false,
      retries: Number(document.verification?.retries ?? 0),
      prompt: text(document.verification?.prompt) || undefined,
    },
    continuation,
    statusFormat: text(
      defaults.statusFormat,
      "🔄️ Iteration {ITERATION:000} - {TYP}-{NUM} - {TASK} (model: `{MODEL}`)",
    ),
  };
}
