import type {
  CircuitBreakerCheckPlan,
  StagePlan,
  TriggerPlan,
  WorkflowPlan,
} from "../config/compiler.js";
import type { CoreContext, Guard, WorkSource } from "../core/plan.js";
import type { ProcessResult } from "../core/process-runner.js";
import type { TaskDocumentReader, TaskSource } from "../core/task.js";
import type { PlaceholderContext } from "../placeholders/placeholders.js";
import type { ExtensionRegistry } from "./registry.js";

export interface ExtensionEvent {
  type: string;
  iteration: number;
  stage?: string;
  message: string;
}

export interface ActionContext {
  source: TaskSource;
  stage: StagePlan;
  values: PlaceholderContext;
  expand: (value: string) => string;
  result: ProcessResult;
  iteration: number;
  emit: (event: ExtensionEvent) => Promise<void>;
}

export type ActionCallback = (context: ActionContext) => Promise<void>;

/**
 * A message is the send-side counterpart to a trigger's wait-side: it fires
 * when a pipeline stage's `onSuccess` hook names it, delivering work to a
 * `target` (e.g. another Ralph instance's observed Markdown file). `target`
 * and `task` are plain expanded strings so a future transport (e.g. grpc) can
 * be registered under this same contract without changing the onSuccess shape.
 */
export interface MessageContext {
  target: string;
  task: string;
  expand: (value: string) => string;
  iteration: number;
  emit: (event: ExtensionEvent) => Promise<void>;
}

export type MessageCallback = (context: MessageContext) => Promise<void>;

export interface PredicateContext {
  path?: string;
  check?: StagePlan;
  expand: (value: string) => string;
  runStage: (stage: StagePlan) => Promise<{ success: boolean }>;
}

export type PredicateCallback = (context: PredicateContext) => Promise<boolean>;

/** A trigger status event; the engine stamps the current iteration on it. */
export type TriggerStatusEvent = Omit<ExtensionEvent, "iteration">;

/**
 * A trigger is the outermost WorkSource: it decides when a workflow run should
 * (re)start. When the inner task/continuation sources are exhausted, the engine
 * consults the configured trigger instead of terminating. `wait` blocks/idles
 * until there is a reason to resume (returning a signal) or resolves `null` to
 * mean "no more work will ever arrive; terminate normally".
 */
export interface TriggerContext {
  /** Trigger kind name, e.g. "taskAppears". */
  kind: string;
  /** Resolved absolute path the trigger observes (defaults to the PRD path). */
  source: string;
  /** Poll interval in milliseconds for polling-based triggers. */
  pollIntervalMs: number;
  /** Workspace root directory. */
  workspace: string;
  /** PRD-bound task source for workflow mutations and task state. */
  taskSource: TaskSource;
  /** Reader bound to the document observed by this trigger. */
  observedSource: TaskDocumentReader;
  /** Placeholder expansion bound to the current context, e.g. `{SOURCE}`. */
  expand: (value: string) => string;
  /** Emit a status event, e.g. while waiting for new work to appear. */
  emit: (event: TriggerStatusEvent) => Promise<void>;
  /** Cancellation signal; triggers must resolve promptly when aborted. */
  signal?: AbortSignal;
}

export interface TriggerSignal {
  /** Human-readable reason the trigger fired, surfaced in events. */
  reason: string;
}

export type TriggerCallback = (
  context: TriggerContext,
) => Promise<TriggerSignal | null>;

/**
 * A circuit breaker check computes a signature describing "what happened this
 * iteration" (e.g. current VCS state, or a failing stage's identity). The engine
 * compares this signature to the last-persisted one for the same check: an
 * unchanged signature across consecutive iterations increments a streak; once the
 * streak reaches the configured threshold, the workflow is blocked. Returning
 * `null` means "not applicable this iteration" and resets the streak for this
 * check (e.g. no failure occurred, or the workspace uses an unsupported VCS).
 */
export interface CircuitBreakerContext {
  /** Check kind name, e.g. "noProgress". */
  kind: string;
  /** Workspace root directory. */
  workspace: string;
  /** Current iteration index (1-based). */
  iteration: number;
  /** Placeholder expansion bound to the current context. */
  expand: (value: string) => string;
  /**
   * Identity + exit code of the most recent failing postAgent stage this
   * iteration, if any. `undefined` when no stage failed this iteration.
   */
  lastFailure?: { stage: string; exitCode: number | null };
}

export type CircuitBreakerCallback = (
  context: CircuitBreakerContext,
) => Promise<string | null>;

export type DtoFragment = Record<string, unknown>;

/** Fields required in the surface YAML when this lowering's `kind` is selected. */
export interface ContinuationSchemaFragment {
  required?: string[];
  /** JSON Schema fragments for properties added by this continuation kind. */
  properties?: Record<string, DtoFragment>;
  /** Declares that `producer` should be validated as a named-producer-or-command. */
  usesProducer?: boolean;
}

export interface ContinuationLoweringContext {
  plan: WorkflowPlan;
  source: TaskSource;
  extensions: ExtensionRegistry;
  base: WorkSource;
}

export interface ContinuationLowering {
  name: string;
  schema?: ContinuationSchemaFragment;
  lower(dto: unknown, context: ContinuationLoweringContext): WorkSource;
}

export interface TriggerLoweringContext {
  plan: WorkflowPlan;
  source: TaskSource;
  /** Reader bound to the trigger's observed document. */
  observedSource: TaskDocumentReader;
  extensions: ExtensionRegistry;
  inner: WorkSource;
}

export interface TriggerLowering {
  name: string;
  schema?: DtoFragment;
  lower(dto: TriggerPlan, context: TriggerLoweringContext): WorkSource;
}

export interface CircuitBreakerLoweringContext {
  plan: WorkflowPlan;
  extensions: ExtensionRegistry;
  expander: import("../placeholders/placeholders.js").PlaceholderExpander;
  values(ctx: CoreContext): PlaceholderContext;
}

export interface CircuitBreakerLowering {
  name: string;
  schema?: DtoFragment;
  lower(
    dto: CircuitBreakerCheckPlan,
    context: CircuitBreakerLoweringContext,
  ): Guard;
}
