import type { ProcessResult } from "./process-runner.js";
import type { Task } from "./task.js";

/** Values shared by steps, predicates, guards, and work-source hooks. */
export interface CoreContext {
  readonly workspace: string;
  readonly iteration: number;
  readonly task: Task;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

/** Result returned by one pipeline step. */
export interface StepResult {
  readonly success: boolean;
  readonly process?: ProcessResult;
  readonly message?: string;
}

export interface Predicate {
  check(ctx: CoreContext): Promise<boolean>;
}

export type Policy =
  | { readonly kind: "stop" }
  | { readonly kind: "continue" }
  | {
      readonly kind: "retry";
      readonly predicate: Predicate;
      readonly times: number;
    }
  | {
      readonly kind: "schedule";
      readonly action: string;
      readonly maxAttempts: number;
    };

export interface Step {
  run(ctx: CoreContext): Promise<StepResult>;
  readonly onFail: Policy;
  readonly role: "pre" | "harness" | "post" | "verify";
  readonly name: string;
  readonly stage?: unknown;
}

export interface WorkSource {
  pull(iteration: number): Promise<Task | null>;
  afterTask?(ctx: CoreContext): Promise<void>;
  readonly completionStatus?: "complete" | "blocked";
  /** Message surfaced by the engine when `completionStatus` is `"blocked"`. */
  readonly blockedMessage?: string;
  /** Rewinds any internal exhaustion cursor so a trigger-driven retry can re-check drained sub-sources. */
  reset?(): void;
}

export interface Guard {
  readonly kind: string;
  readonly threshold: number;
  signature(ctx: CoreContext): Promise<string | null>;
}

export type OutcomeStatus = "blocked" | "processFailure" | "canceled";

export interface StepFailure {
  readonly step: Step;
  readonly result: StepResult;
}

export type Outcome =
  | {
      readonly terminal: false;
      readonly lastFailure: StepFailure | null;
      readonly scheduled: boolean;
    }
  | {
      readonly terminal: true;
      readonly status: OutcomeStatus;
      readonly message: string;
      readonly lastFailure?: StepFailure;
    };

export interface CorePlan {
  readonly workspace: string;
  readonly maxIterations: number;
  readonly source: WorkSource;
  /** When true, the engine checks each task after all successful gates. */
  readonly completeTask?: boolean;
  readonly steps: Step[];
  readonly guards: Guard[];
  status(ctx: CoreContext): string;
  context?(ctx: CoreContext): Record<string, unknown>;
  runStage?(stage: unknown, ctx: CoreContext): Promise<StepResult>;
}
