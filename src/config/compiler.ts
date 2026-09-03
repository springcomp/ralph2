import { isAbsolute, normalize, resolve } from "node:path";
import { parseEnvAssignment } from "../core/env-file.js";
import type { CorePlan } from "../core/plan.js";
import type { TaskSource } from "../core/task.js";
import {
  type ExtensionRegistry,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
import { PlaceholderExpander } from "../placeholders/placeholders.js";
import type { PlaceholderContext } from "../placeholders/placeholders.js";
import { lowerSteps, runStage } from "./lowering/steps.js";
import { lowerWorkSource } from "./lowering/worksource.js";
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
  maxRemediationAttempts?: number;
  harness?: string;
  model?: string | null;
  agent?: string | null;
  /** CLI-resolved --pty/--no-pty override; undefined = auto-detect per stage */
  pty?: boolean;
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
  envFilePath?: string;
  timeoutMs: number;
  successExitCodes: number[];
  outputPath?: string;
  failureAction?: string;
  failureTask?: string;
  failurePolicy: "stop" | "continue";
  /** undefined = inherit workflow-level ptyDefault */
  pty?: boolean;
  mandatory?: boolean;
  resultPath?: string;
  resultRequired?: boolean;
}
export interface TaskFileSet {
  queue?: string;
  /** Legacy alias for queue, retained for placeholder and API compatibility. */
  prd: string;
  progress: string;
  prompt: string;
  completion?: "agent" | "engine";
}
export interface TriggerPlan {
  kind: string;
  source: string;
  pollIntervalMs: number;
}
export interface CircuitBreakerCheckPlan {
  kind: string;
  threshold: number;
}
export interface CircuitBreakerPlan {
  checks: CircuitBreakerCheckPlan[];
}
export interface WorkflowPlan {
  workspace: string;
  environment?: EnvironmentVariablePlan[];
  envFilePath?: string;
  maxIterations: number;
  maxRemediationAttempts: number;
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
    /** Custom continuation kinds carry their own extra properties through untouched. */
    [key: string]: unknown;
    kind: string;
    source?: string;
    completeWhenSourceExhausted: boolean;
    seedTask?: string;
    nextTask?: string;
    producer?: StagePlan;
    completeWhen?: {
      kind: string;
      path?: string;
      check?: StagePlan;
    };
  };
  statusFormat: string;
  /** CLI-resolved --pty/--no-pty override; undefined = auto-detect per stage */
  ptyDefault?: boolean;
  trigger?: TriggerPlan;
  circuitBreaker?: CircuitBreakerPlan;
  goalPath?: string;
  completion?: "agent" | "engine";
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
const toEnvironmentPlan = (
  entries: readonly (
    | import("./schema-v1.js").EnvironmentVariableDto
    | string
  )[],
): EnvironmentVariablePlan[] =>
  entries.flatMap((entry) => {
    if (typeof entry === "string") {
      const parsed = parseEnvAssignment(entry);
      return parsed
        ? [{ name: parsed.name, value: parsed.value, secret: false }]
        : [];
    }
    return [
      {
        name: text(entry.name),
        value: text(entry.value),
        secret: entry.secret === true,
      },
    ];
  });
function resolveProducerDto(
  producer: string | import("./schema-v1.js").CommandDto | null | undefined,
  extensions: ExtensionRegistry,
): CommandDto | undefined {
  if (!producer) return undefined;
  if (typeof producer === "string")
    return extensions.producer(producer)?.create();
  return producer;
}
function stage(
  name: string,
  dto: CommandDto,
  workspace: string,
  ptyDefault?: boolean,
): StagePlan {
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
      ? toEnvironmentPlan(dto.environment)
      : [],
    envFilePath: path(workspace, dto.envFile),
    timeoutMs: parseTimeout(dto.timeout),
    successExitCodes:
      Array.isArray(dto.successExitCodes) && dto.successExitCodes.length
        ? [...dto.successExitCodes].map(Number)
        : [0],
    outputPath: path(workspace, dto.output?.combined),
    failureAction: text(dto.onFailure?.action) || undefined,
    failureTask: text(dto.onFailure?.task) || undefined,
    failurePolicy: dto.failurePolicy === "continue" ? "continue" : "stop",
    pty: typeof dto.pty === "boolean" ? dto.pty : ptyDefault,
    mandatory: dto.mandatory !== false,
    resultPath: path(workspace, dto.result?.path),
    resultRequired: dto.result?.required === true,
  };
}
export function compileWorkflow(
  document: V1WorkflowDocument,
  configDirectory: string,
  options: CompileOptions = {},
  extensions: ExtensionRegistry = defaultExtensionRegistry,
): WorkflowPlan {
  const diagnostics = validateWorkflow(document, extensions);
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
      stage(name, dto, workspace, options.pty),
    ]),
  );
  const continuationDto =
    document.continuation && typeof document.continuation === "object"
      ? (document.continuation as Record<string, unknown>)
      : undefined;
  const continuation = continuationDto
    ? {
        ...continuationDto,
        kind: text(continuationDto.kind),
        source: path(workspace, continuationDto.source),
        completeWhenSourceExhausted:
          continuationDto.completeWhenSourceExhausted === true,
        seedTask: text(continuationDto.seedTask) || undefined,
        nextTask: text(continuationDto.nextTask) || undefined,
        producer: (() => {
          const dto = resolveProducerDto(
            continuationDto.producer as
              | string
              | import("./schema-v1.js").CommandDto
              | null
              | undefined,
            extensions,
          );
          return dto
            ? stage("producer", dto, workspace, options.pty)
            : undefined;
        })(),
        completeWhen:
          continuationDto.completeWhen &&
          typeof continuationDto.completeWhen === "object"
            ? (() => {
                const completeWhenDto = continuationDto.completeWhen as Record<
                  string,
                  unknown
                >;
                return {
                  kind: text(completeWhenDto.kind),
                  path: path(workspace, completeWhenDto.path),
                  check: completeWhenDto.check
                    ? stage(
                        "completion-check",
                        completeWhenDto.check as CommandDto,
                        workspace,
                        options.pty,
                      )
                    : undefined,
                };
              })()
            : undefined,
      }
    : undefined;
  const queuePath = path(workspace, tasks.queue);
  const prdPath = path(workspace, tasks.prd);
  if (queuePath && prdPath && queuePath !== prdPath) {
    throw new WorkflowCompileError([
      {
        path: "tasks",
        message: "queue and prd must resolve to the same file",
      },
    ]);
  }
  const canonicalQueuePath = queuePath ?? prdPath ?? "";
  const triggerDto = document.trigger;
  const trigger: TriggerPlan | undefined = triggerDto
    ? {
        kind: text(triggerDto.kind),
        source: path(workspace, triggerDto.source) ?? canonicalQueuePath,
        pollIntervalMs:
          triggerDto.pollInterval === undefined ||
          triggerDto.pollInterval === null ||
          triggerDto.pollInterval === ""
            ? 5000
            : parseTimeout(triggerDto.pollInterval),
      }
    : undefined;
  const circuitBreakerDto = document.circuitBreaker;
  const circuitBreaker: CircuitBreakerPlan | undefined = circuitBreakerDto
    ? {
        checks: (circuitBreakerDto.checks ?? []).map((c) => ({
          kind: text(c.kind),
          threshold:
            typeof c.threshold === "number" && c.threshold > 0
              ? c.threshold
              : 3,
        })),
      }
    : undefined;
  return {
    workspace,
    environment: Array.isArray(document.environment)
      ? toEnvironmentPlan(document.environment)
      : [],
    envFilePath: path(workspace, document.envFile),
    maxIterations: options.maxIterations ?? Number(document.maxIterations),
    maxRemediationAttempts:
      options.maxRemediationAttempts ??
      (typeof document.maxRemediationAttempts === "number" &&
      Number.isInteger(document.maxRemediationAttempts) &&
      document.maxRemediationAttempts >= 0
        ? document.maxRemediationAttempts
        : 2),
    tasks: {
      queue: canonicalQueuePath,
      prd: canonicalQueuePath,
      progress: path(workspace, tasks.progress) ?? "",
      prompt: path(workspace, tasks.prompt) ?? "",
      completion: tasks.completion === "engine" ? "engine" : "agent",
    },
    harnesses,
    defaultHarness: options.harness ?? text(defaults.harness),
    model:
      typeof options.model === "string" && options.model.trim()
        ? options.model
        : text(defaults.model) || null,
    agent:
      typeof options.agent === "string" && options.agent.trim()
        ? options.agent
        : text(defaults.agent) || null,
    preAgent: (document.preAgent ?? []).map((x, i) =>
      stage(
        x.name ? text(x.name) : `preAgent[${i}]`,
        x,
        workspace,
        options.pty,
      ),
    ),
    postAgent: (document.postAgent ?? []).map((x, i) =>
      stage(
        x.name ? text(x.name) : `postAgent[${i}]`,
        x,
        workspace,
        options.pty,
      ),
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
    ptyDefault: options.pty,
    trigger,
    circuitBreaker,
    goalPath: path(workspace, document.goal),
    completion: tasks.completion === "engine" ? "engine" : "agent",
  };
}

export function compileCore(
  document: V1WorkflowDocument,
  configDirectory: string,
  source: TaskSource,
  options: CompileOptions = {},
  extensions: ExtensionRegistry = defaultExtensionRegistry,
): CorePlan {
  const plan = compileWorkflow(document, configDirectory, options, extensions);
  const expander = new PlaceholderExpander();
  const values = (
    ctx: import("../core/plan.js").CoreContext,
  ): PlaceholderContext => ({
    model: typeof ctx.model === "string" ? ctx.model : plan.model,
    agent: typeof ctx.agent === "string" ? ctx.agent : plan.agent,
    type: ctx.task.typ,
    number: ctx.task.num,
    task: ctx.task.description,
    taskLine: ctx.task.rawLine,
    root: `${ctx.task.typ}-${ctx.task.num}`,
    prompt: plan.tasks.prompt,
    queue: plan.tasks.queue ?? plan.tasks.prd,
    goal: plan.goalPath,
    prd: plan.tasks.queue ?? plan.tasks.prd,
    progress: plan.tasks.progress,
    iteration: ctx.iteration,
    workspace: plan.workspace,
  });
  return {
    workspace: plan.workspace,
    maxIterations: plan.maxIterations,
    source: lowerWorkSource(plan, source, extensions),
    completeTask: plan.completion === "engine",
    steps: lowerSteps(plan, source, expander),
    guards: (plan.circuitBreaker?.checks ?? []).map((check) => {
      const lowering = extensions.circuitBreakerLowering(check.kind);
      if (!lowering)
        throw new Error(
          `Circuit breaker check '${check.kind}' lowering is not registered.`,
        );
      return lowering.lower(check, {
        plan,
        extensions,
        expander,
        values,
      });
    }),
    context: (ctx) => values(ctx) as unknown as Record<string, unknown>,
    runStage: (stage, ctx) =>
      runStage(
        stage as StagePlan,
        {
          ...ctx,
          runner: (
            ctx as import("../core/plan.js").CoreContext & {
              runner: import("../core/process-runner.js").ProcessRunner;
            }
          ).runner,
          expander,
          plan,
        } as never,
      ),
    status: (ctx) => expander.expand(plan.statusFormat, values(ctx)),
  };
}
