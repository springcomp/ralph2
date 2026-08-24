import type { StagePlan } from "../config/compiler.js";
import type { MarkdownTaskSource } from "../core/markdown-task-source.js";
import type { PlaceholderContext } from "../core/placeholders.js";
import type { ProcessResult } from "../core/process-runner.js";

export interface ExtensionEvent {
  type: string;
  iteration: number;
  stage?: string;
  message: string;
}

export interface ActionContext {
  source: MarkdownTaskSource;
  prdPath: string;
  stage: StagePlan;
  values: PlaceholderContext;
  expand: (value: string) => string;
  result: ProcessResult;
  iteration: number;
  emit: (event: ExtensionEvent) => Promise<void>;
}

export type ActionCallback = (context: ActionContext) => Promise<void>;

export interface PredicateContext {
  path?: string;
  check?: StagePlan;
  expand: (value: string) => string;
  runStage: (stage: StagePlan) => Promise<{ success: boolean }>;
}

export type PredicateCallback = (context: PredicateContext) => Promise<boolean>;

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
  /** Shared Markdown task source for reusing task-parsing/exhaustion logic. */
  taskSource: MarkdownTaskSource;
  /** Placeholder expansion bound to the current context. */
  expand: (value: string) => string;
  /** Emit a structured workflow event. */
  emit: (event: ExtensionEvent) => Promise<void>;
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
