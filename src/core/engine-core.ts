import {
  type ExtensionRegistry,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
import { PlaceholderExpander } from "../placeholders/placeholders.js";
import { evaluateCircuitBreaker } from "./circuit-breaker.js";
import { WorkflowExitCodes } from "./exit-codes.js";
import { WorkspaceLock } from "./locks.js";
import { type PipelineContext, run as runPipeline } from "./pipeline.js";
import type { CoreContext, CorePlan, StepFailure } from "./plan.js";
import type { ProcessRunner } from "./process-runner.js";
import type { Task, TaskSource } from "./task.js";
import type {
  WorkflowEngineCallbacks,
  WorkflowEvent,
  WorkflowOptions,
  WorkflowRunResult,
} from "./workflow-types.js";

export class CoreEngine {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly source: TaskSource,
    private readonly callbacks: WorkflowEngineCallbacks = {},
    private readonly extensions: ExtensionRegistry = defaultExtensionRegistry,
    private readonly expander = new PlaceholderExpander(),
  ) {}

  async run(
    plan: CorePlan,
    options: WorkflowOptions = {},
  ): Promise<WorkflowRunResult> {
    const events: WorkflowEvent[] = [];
    const emit = async (event: WorkflowEvent) => {
      events.push(event);
      await this.callbacks.onEvent?.(event);
    };
    const lock = new WorkspaceLock(plan.workspace);
    try {
      await lock.acquire();
    } catch (error) {
      return this.result("blocked", this.message(error), 0, events);
    }
    const max = options.maxIterations ?? plan.maxIterations;
    try {
      for (let iteration = 1; iteration <= max; iteration++) {
        if (options.signal?.aborted)
          return this.result("canceled", "Canceled.", iteration - 1, events);
        let task: Task | null;
        try {
          task = await plan.source.pull(iteration);
        } catch (error) {
          if (this.message(error).startsWith("Trigger '")) {
            await emit({
              type: "trig" + "ger.error",
              iteration,
              message: this.message(error),
            });
            return this.result(
              "complete",
              "No unchecked tasks remain.",
              iteration - 1,
              events,
            );
          }
          return this.result(
            "blocked",
            this.message(error),
            iteration - 1,
            events,
          );
        }
        if (!task) {
          const status = plan.source.completionStatus ?? "complete";
          return this.result(
            status,
            status === "blocked"
              ? (plan.source.blockedMessage ?? "Blocked.")
              : "No unchecked tasks remain.",
            iteration - 1,
            events,
          );
        }
        let rootId: string;
        try {
          rootId = (await this.source.remediationDepth(task)).rootId;
        } catch (error) {
          return this.result(
            "blocked",
            this.message(error),
            iteration - 1,
            events,
          );
        }
        const baseContext = plan.context?.({
          workspace: plan.workspace,
          iteration,
          task,
          signal: options.signal,
        });
        const ctx: PipelineContext = {
          ...baseContext,
          workspace: plan.workspace,
          iteration,
          task,
          signal: options.signal,
          model:
            (typeof task.model === "string" && task.model.trim()
              ? task.model
              : undefined) ??
            (typeof options.model === "string" && options.model.trim()
              ? options.model
              : undefined) ??
            (typeof baseContext?.model === "string" && baseContext.model.trim()
              ? baseContext.model
              : undefined),
          agent:
            (typeof task.agent === "string" && task.agent.trim()
              ? task.agent
              : undefined) ??
            (typeof options.agent === "string" && options.agent.trim()
              ? options.agent
              : undefined) ??
            (typeof baseContext?.agent === "string" && baseContext.agent.trim()
              ? baseContext.agent
              : undefined),
          root: rootId,
          runner: this.runner,
          source: this.source,
          expand: (value: string) => this.expander.expand(value, ctx as never),
          runStage: (stage: unknown, stageCtx: CoreContext) =>
            plan.runStage
              ? plan.runStage(stage, { ...stageCtx, runner: this.runner })
              : Promise.reject(new Error("Stage runner unavailable.")),
          emit,
          schedule: (policy, failure) =>
            this.schedule(plan, ctx, policy, failure, iteration, emit),
        };
        await emit({
          type: "task.started",
          iteration,
          message: `Processing ${task.id}: ${task.description}`,
        });
        await this.callbacks.onStatus?.(
          plan.status({
            ...ctx,
            model:
              typeof ctx.model === "string" && ctx.model.trim()
                ? ctx.model
                : "(default)",
          }),
        );
        const outcome = await runPipeline(plan.steps, ctx, iteration);
        if (outcome.terminal)
          return this.result(
            outcome.status,
            outcome.message,
            iteration,
            events,
          );
        // A remediation is work for the next iteration. Do not run guards or
        // continuation hooks for an iteration whose mandatory gate failed.
        if (outcome.scheduled) continue;
        const guardMessage = await this.guards(
          plan,
          ctx,
          outcome.lastFailure,
          emit,
        );
        if (guardMessage)
          return this.result("blocked", guardMessage, iteration, events);
        if (plan.completeTask) {
          try {
            await this.source.checkTask(ctx.task);
          } catch (error) {
            return this.result(
              "blocked",
              `Task completion failed: ${this.message(error)}`,
              iteration,
              events,
            );
          }
        }
        try {
          await plan.source.afterTask?.(ctx);
        } catch (error) {
          return this.result("blocked", this.message(error), iteration, events);
        }
      }
      await emit({
        type: "workflow.iterationLimit",
        iteration: max,
        message: "Iteration limit reached.",
      });
      return this.result(
        "iterationLimit",
        "Iteration limit reached.",
        max,
        events,
      );
    } finally {
      await lock.release();
    }
  }

  async runAsync(plan: CorePlan, options: WorkflowOptions = {}) {
    return this.run(plan, options);
  }

  private async schedule(
    plan: CorePlan,
    ctx: PipelineContext,
    policy: Extract<import("./plan.js").Policy, { kind: "schedule" }>,
    failure: StepFailure,
    iteration: number,
    emit: (event: WorkflowEvent) => Promise<void>,
  ): Promise<"scheduled" | WorkflowRunResult> {
    const source = this.source;
    const action = this.extensions.action(policy.action);
    if (!action)
      return this.result(
        "blocked",
        `Action '${policy.action}' is not registered.`,
        iteration,
        [],
      );
    const stage = failure.step.stage as
      | import("../config/compiler.js").StagePlan
      | undefined;
    if (!stage)
      return this.result(
        "blocked",
        "Scheduled failure has no stage.",
        iteration,
        [],
      );
    const depth = await source.remediationDepth(ctx.task);
    if (depth.depth >= policy.maxAttempts) {
      await emit({
        type: "remediation.exhausted",
        iteration,
        stage: failure.step.name,
        message: `Maximum remediation attempts (${policy.maxAttempts}) reached for ${depth.rootId}.`,
      });
      return this.result(
        "blocked",
        `Maximum remediation attempts (${policy.maxAttempts}) reached for ${depth.rootId}.`,
        iteration,
        [],
      );
    }
    await action.callback({
      source,
      stage,
      values: ctx as never,
      expand: (value) => this.expander.expand(value, ctx as never),
      result: failure.result.process ?? {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
      },
      iteration,
      emit,
    });
    return "scheduled";
  }

  private async guards(
    plan: CorePlan,
    ctx: CoreContext,
    failure: StepFailure | null,
    emit: (event: WorkflowEvent) => Promise<void>,
  ): Promise<string | null> {
    for (const guard of plan.guards) {
      let signature: string | null;
      try {
        signature = await guard.signature({
          ...ctx,
          lastFailure: failure
            ? {
                stage: failure.step.name,
                exitCode: failure.result.process?.exitCode ?? null,
              }
            : undefined,
        });
      } catch (error) {
        await emit({
          type: "circuitBreaker.error",
          iteration: ctx.iteration,
          message: this.message(error),
        });
        continue;
      }
      const evaluation = await evaluateCircuitBreaker(
        plan.workspace,
        guard.kind,
        guard.threshold,
        signature,
      );
      if (evaluation.signature === null) {
        await emit({
          type: "circuitBreaker.reset",
          iteration: ctx.iteration,
          message: `Circuit breaker '${guard.kind}' reset.`,
        });
      } else if (evaluation.tripped) {
        await emit({
          type: "circuitBreaker.tripped",
          iteration: ctx.iteration,
          message: `Circuit breaker '${guard.kind}' tripped after ${evaluation.streak} consecutive occurrences of '${evaluation.signature}' (threshold ${guard.threshold}).`,
        });
        return `Circuit breaker '${guard.kind}' tripped: '${evaluation.signature}' repeated ${evaluation.streak} times (threshold ${guard.threshold}).`;
      } else {
        await emit({
          type: "circuitBreaker.streak",
          iteration: ctx.iteration,
          message: `Circuit breaker '${guard.kind}' streak ${evaluation.streak}/${guard.threshold} (${evaluation.signature}).`,
        });
      }
    }
    return null;
  }

  private result(
    status: WorkflowRunResult["status"],
    message: string,
    iterations: number,
    events: WorkflowEvent[],
  ): WorkflowRunResult {
    const exitCode =
      status === "complete"
        ? 0
        : status === "blocked"
          ? 3
          : status === "iterationLimit"
            ? 4
            : 5;
    return { status, message, iterations, events, exitCode };
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

export { CoreEngine as WorkflowEngineCore };
