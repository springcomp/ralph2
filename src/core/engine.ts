import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StagePlan, WorkflowPlan } from "../config/compiler.js";
import {
  type ExtensionRegistry,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
import { evaluateCircuitBreaker } from "./circuit-breaker.js";
import { loadEnvFile } from "./env-file.js";
import { WorkflowExitCodes } from "./exit-codes.js";
import { WorkspaceLock } from "./locks.js";
import {
  type MarkdownTask,
  MarkdownTaskSource,
} from "./markdown-task-source.js";
import {
  type PlaceholderContext,
  PlaceholderExpander,
} from "./placeholders.js";
import type { ProcessResult, ProcessRunner } from "./process-runner.js";

export type WorkflowStatus =
  | "complete"
  | "blocked"
  | "iterationLimit"
  | "processFailure"
  | "canceled";
export interface WorkflowEvent {
  type: string;
  iteration: number;
  stage?: string;
  message: string;
}
export interface WorkflowOptions {
  model?: string | null;
  agent?: string | null;
  harness?: string;
  maxIterations?: number;
  signal?: AbortSignal;
}
export interface WorkflowRunResult {
  status: WorkflowStatus;
  message: string;
  iterations: number;
  events: WorkflowEvent[];
  exitCode: number;
}
export interface WorkflowEngineCallbacks {
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
  onStatus?: (status: string) => void | Promise<void>;
}

const exitCode = (status: WorkflowStatus): number =>
  ({
    complete: WorkflowExitCodes.Complete,
    blocked: WorkflowExitCodes.Blocked,
    iterationLimit: WorkflowExitCodes.IterationLimitReached,
    processFailure: WorkflowExitCodes.ProcessFailure,
    canceled: WorkflowExitCodes.ProcessFailure,
  })[status];

export class WorkflowEngine {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly source = new MarkdownTaskSource(),
    private readonly expander = new PlaceholderExpander(),
    private readonly callbacks: WorkflowEngineCallbacks = {},
    private readonly extensions: ExtensionRegistry = defaultExtensionRegistry,
  ) {}

  async run(
    plan: WorkflowPlan,
    options: WorkflowOptions = {},
  ): Promise<WorkflowRunResult> {
    const events: WorkflowEvent[] = [];
    const emit = async (event: WorkflowEvent) => {
      events.push(event);
      await this.callbacks.onEvent?.(event);
    };
    const workspace = plan.workspace;
    const lock = new WorkspaceLock(workspace);
    try {
      await lock.acquire();
    } catch (error) {
      return this.result(
        "blocked",
        error instanceof Error ? error.message : String(error),
        0,
        events,
      );
    }
    await mkdir(workspace, { recursive: true });
    const max = options.maxIterations ?? plan.maxIterations;
    try {
      for (let iteration = 1; iteration <= max; iteration++) {
        if (options.signal?.aborted)
          return this.result("canceled", "Canceled.", iteration - 1, events);
        let task: MarkdownTask | null;
        try {
          task = await this.source.getFirstUncheckedTask(plan.tasks.prd);
        } catch (error) {
          return this.result(
            "blocked",
            this.message(error),
            iteration - 1,
            events,
          );
        }
        if (!task) {
          const continuation = await this.continueWhenEmpty(
            plan,
            iteration,
            events,
            options,
          );
          if (continuation) {
            if (continuation.status === "complete" && plan.trigger) {
              const fired = await this.awaitTrigger(
                plan,
                iteration,
                emit,
                options,
              );
              if (fired === "canceled")
                return this.result(
                  "canceled",
                  "Canceled.",
                  iteration - 1,
                  events,
                );
              if (fired === "fired") continue;
            }
            return continuation;
          }
          continue;
        }
        const original = task;
        const originalValues = this.values(plan, original, options, iteration);
        const values = originalValues;
        let remediationScheduled = false;
        await emit({
          type: "task.started",
          iteration,
          message: `Processing ${task.id}: ${task.description}`,
        });
        const modelForStatus = values.model?.trim()
          ? values.model
          : "(default)";
        await this.callbacks.onStatus?.(
          this.expander.expand(plan.statusFormat, {
            ...values,
            model: modelForStatus,
          }),
        );
        const harnessName = options.harness ?? plan.defaultHarness;
        const harness = plan.harnesses[harnessName];
        if (!harness)
          return this.result(
            "blocked",
            `Harness '${harnessName}' is not configured.`,
            iteration,
            events,
          );

        for (const stage of plan.preAgent) {
          const failure = await this.runStage(
            plan,
            stage,
            values,
            workspace,
            iteration,
            emit,
            options.signal,
          );
          if (!failure.success) {
            const handled = await this.handleFailure(
              plan,
              stage,
              values,
              original,
              failure.result,
              iteration,
              emit,
            );
            if (handled && handled !== "scheduled") return handled;
            remediationScheduled = Boolean(handled === "scheduled");
            if (!remediationScheduled && stage.mandatory !== false)
              return this.failure(failure.result, iteration, events);
          }
          if (remediationScheduled) break;
        }
        if (remediationScheduled) continue;
        let run = await this.runStage(
          plan,
          harness,
          values,
          workspace,
          iteration,
          emit,
          options.signal,
        );
        if (!run.success) return this.failure(run.result, iteration, events);
        let lastFailure: { stage: string; exitCode: number | null } | undefined;
        for (const stage of plan.postAgent) {
          run = await this.runStage(
            plan,
            stage,
            values,
            workspace,
            iteration,
            emit,
            options.signal,
          );
          if (!run.success) {
            lastFailure = { stage: stage.name, exitCode: run.result.exitCode };
            const handled = await this.handleFailure(
              plan,
              stage,
              values,
              original,
              run.result,
              iteration,
              emit,
            );
            if (handled && handled !== "scheduled") return handled;
            if (handled === "scheduled") {
              remediationScheduled = true;
              break;
            }
            if (stage.mandatory !== false)
              return this.failure(run.result, iteration, events);
          }
        }
        const tripped = await this.runCircuitBreakers(
          plan,
          iteration,
          values,
          lastFailure,
          emit,
        );
        if (tripped) return this.result("blocked", tripped, iteration, events);
        if (remediationScheduled) continue;
        let originalUnchecked = false;
        try {
          originalUnchecked =
            plan.verification.requireTaskChecked &&
            (await this.stillUnchecked(plan.tasks.prd, original));
        } catch (error) {
          return this.result("blocked", this.message(error), iteration, events);
        }
        if (originalUnchecked) {
          for (let retry = 0; retry < plan.verification.retries; retry++) {
            let verifyValues = originalValues;
            if (plan.verification.prompt) {
              const promptPath = `${workspace}/.agentic/__verification.prompt.md`;
              await mkdir(dirname(promptPath), { recursive: true });
              await writeFile(
                promptPath,
                this.expander.expand(plan.verification.prompt, verifyValues),
                "utf8",
              );
              verifyValues = { ...verifyValues, prompt: promptPath };
            }
            run = await this.runStage(
              plan,
              harness,
              verifyValues,
              workspace,
              iteration,
              emit,
              options.signal,
            );
            if (!run.success)
              return this.failure(run.result, iteration, events);
            try {
              if (!(await this.stillUnchecked(plan.tasks.prd, original))) break;
            } catch (error) {
              return this.result(
                "blocked",
                this.message(error),
                iteration,
                events,
              );
            }
          }
          try {
            originalUnchecked = await this.stillUnchecked(
              plan.tasks.prd,
              original,
            );
          } catch (error) {
            return this.result(
              "blocked",
              this.message(error),
              iteration,
              events,
            );
          }
          if (originalUnchecked)
            return this.result(
              "blocked",
              `Task ${original.id} remained unchecked after verification.`,
              iteration,
              events,
            );
        }
        const continuation = await this.continueAfterTask(
          plan,
          originalValues,
          iteration,
          events,
          options,
        );
        if (continuation) return continuation;
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

  async runAsync(
    plan: WorkflowPlan,
    options: WorkflowOptions = {},
  ): Promise<WorkflowRunResult> {
    return this.run(plan, options);
  }
  private values(
    plan: WorkflowPlan,
    task: MarkdownTask,
    options: WorkflowOptions,
    iteration: number,
  ): PlaceholderContext {
    return {
      model: task.model ?? options.model ?? plan.model,
      agent: task.agent ?? options.agent ?? plan.agent,
      type: task.typ,
      number: task.num,
      task: task.description,
      taskLine: task.rawLine,
      prompt: plan.tasks.prompt,
      prd: plan.tasks.prd,
      progress: plan.tasks.progress,
      iteration,
      workspace: plan.workspace,
    };
  }
  private async stillUnchecked(
    path: string,
    target: MarkdownTask,
  ): Promise<boolean> {
    return this.source.isTaskUnchecked(path, target);
  }
  private async runStage(
    plan: WorkflowPlan,
    stage: StagePlan,
    values: PlaceholderContext,
    workspace: string,
    iteration: number,
    emit: (e: WorkflowEvent) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const args = this.expander.expandArguments(stage, values);
    let env: Record<string, { value: string; secret: boolean }>;
    let envLoadFailed = false;
    try {
      const merged: Record<string, { value: string; secret: boolean }> = {};
      const addFile = async (filePath: string | undefined) => {
        if (!filePath) return;
        for (const [name, value] of Object.entries(await loadEnvFile(filePath)))
          merged[name] = { value, secret: false };
      };
      await addFile(plan.envFilePath);
      for (const x of plan.environment ?? [])
        merged[x.name] = {
          value: this.expander.expand(x.value, values),
          secret: x.secret,
        };
      await addFile(stage.envFilePath);
      for (const x of stage.environment ?? [])
        merged[x.name] = {
          value: this.expander.expand(x.value, values),
          secret: x.secret,
        };
      env = merged;
    } catch {
      envLoadFailed = true;
      env = {};
    }
    await emit({
      type: "stage.started",
      iteration,
      stage: stage.name,
      message: "Stage started.",
    });
    let result: ProcessResult;
    try {
      if (envLoadFailed) {
        result = {
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
        };
      } else {
        result = await this.runner.run({
          command: this.expander.expand(stage.executable, values),
          args,
          cwd: workspace,
          env,
          outputPath: stage.outputPath
            ? this.expander.expand(stage.outputPath, values)
            : undefined,
          timeoutMs: stage.timeoutMs,
          signal,
          usePty: stage.pty,
        });
      }
    } catch {
      result = {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
      };
    }
    const success =
      !result.timedOut &&
      !result.cancelled &&
      result.exitCode !== null &&
      stage.successExitCodes.includes(result.exitCode);
    const artifactFailure =
      success && stage.resultRequired
        ? !(await this.validateResultArtifact(stage, values))
        : false;
    await emit({
      type: "stage.completed",
      iteration,
      stage: stage.name,
      message: result.cancelled
        ? "Stage canceled."
        : artifactFailure
          ? "Required result artifact is missing or invalid."
          : success
            ? "Stage succeeded."
            : result.timedOut
              ? "Stage timed out."
              : `Stage exited with code ${result.exitCode}.`,
    });
    return { result, success: success && !artifactFailure };
  }
  private async validateResultArtifact(
    stage: StagePlan,
    values: PlaceholderContext,
  ): Promise<boolean> {
    if (!stage.resultPath) return false;
    try {
      const content = await readFile(
        this.expander.expand(stage.resultPath, values),
        "utf8",
      );
      const parsed: unknown = JSON.parse(content);
      return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT")
      )
        return false;
      throw error;
    }
  }
  private async handleFailure(
    plan: WorkflowPlan,
    stage: StagePlan,
    values: PlaceholderContext,
    task: MarkdownTask,
    result: ProcessResult,
    iteration: number,
    emit: (e: WorkflowEvent) => Promise<void>,
  ): Promise<WorkflowRunResult | "scheduled" | null> {
    if (stage.failureAction || stage.failureTask) {
      let remediation: { depth: number; rootId: string };
      try {
        remediation = await this.source.remediationDepth(plan.tasks.prd, task);
      } catch (error) {
        return this.result("blocked", this.message(error), iteration, []);
      }
      const remediationAttempts = remediation.depth;
      if (remediationAttempts >= plan.maxRemediationAttempts) {
        await emit({
          type: "remediation.exhausted",
          iteration,
          stage: stage.name,
          message: `Maximum remediation attempts (${plan.maxRemediationAttempts}) reached for ${remediation.rootId}.`,
        });
        return this.result(
          "blocked",
          `Maximum remediation attempts (${plan.maxRemediationAttempts}) reached for ${remediation.rootId}.`,
          iteration,
          [],
        );
      }
      const actionName = stage.failureAction ?? "scheduleTask";
      const action = this.extensions.action(actionName);
      if (!action)
        return this.result(
          "blocked",
          `Action '${actionName}' is not registered.`,
          iteration,
          [],
        );
      try {
        await action.callback({
          source: this.source,
          prdPath: plan.tasks.prd,
          stage,
          values,
          expand: (value) => this.expander.expand(value, values),
          result,
          iteration,
          emit,
        });
      } catch (error) {
        return this.result("blocked", this.message(error), iteration, []);
      }
      // A failure task belongs to the next iteration, never this completion path.
      return "scheduled";
    }
    if (stage.failurePolicy === "continue") {
      await emit({
        type: "stage.continued",
        iteration,
        stage: stage.name,
        message: "Continuing after stage failure.",
      });
      return null;
    }
    return this.failure(result, iteration, []);
  }
  private failure(
    result: ProcessResult,
    iteration: number,
    events: WorkflowEvent[],
  ): WorkflowRunResult {
    return this.result(
      result.cancelled ? "canceled" : "processFailure",
      result.timedOut
        ? "Process timed out."
        : `Process exited with code ${result.exitCode}.`,
      iteration,
      events,
    );
  }
  private result(
    status: WorkflowStatus,
    message: string,
    iterations: number,
    events: WorkflowEvent[],
  ): WorkflowRunResult {
    return { status, message, iterations, events, exitCode: exitCode(status) };
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async awaitTrigger(
    plan: WorkflowPlan,
    iteration: number,
    emit: (e: WorkflowEvent) => Promise<void>,
    options: WorkflowOptions,
  ): Promise<"fired" | "terminated" | "canceled"> {
    const config = plan.trigger;
    if (!config) return "terminated";
    if (options.signal?.aborted) return "canceled";
    const registration = this.extensions.trigger(config.kind);
    if (!registration) {
      await emit({
        type: "trigger.error",
        iteration,
        message: `Trigger '${config.kind}' is not registered.`,
      });
      return "terminated";
    }
    await emit({
      type: "trigger.waiting",
      iteration,
      message: `Idle; waiting on trigger '${config.kind}'.`,
    });
    let signal: import("../extensions/types.js").TriggerSignal | null;
    try {
      signal = await registration.callback({
        kind: config.kind,
        source: config.source,
        pollIntervalMs: config.pollIntervalMs,
        workspace: plan.workspace,
        taskSource: this.source,
        expand: (value) =>
          this.expander.expand(value, {
            workspace: plan.workspace,
            iteration,
          } as PlaceholderContext),
        emit: async (event) => {
          await emit(event as WorkflowEvent);
        },
        signal: options.signal,
      });
    } catch (error) {
      await emit({
        type: "trigger.error",
        iteration,
        message: this.message(error),
      });
      return "terminated";
    }
    if (options.signal?.aborted) return "canceled";
    if (!signal) {
      await emit({
        type: "trigger.terminated",
        iteration,
        message: "Trigger will not fire again; completing.",
      });
      return "terminated";
    }
    await emit({
      type: "trigger.fired",
      iteration,
      message: signal.reason,
    });
    return "fired";
  }

  private async runCircuitBreakers(
    plan: WorkflowPlan,
    iteration: number,
    values: PlaceholderContext,
    lastFailure: { stage: string; exitCode: number | null } | undefined,
    emit: (e: WorkflowEvent) => Promise<void>,
  ): Promise<string | null> {
    const checks = plan.circuitBreaker?.checks;
    if (!checks || checks.length === 0) return null;
    for (const check of checks) {
      const registration = this.extensions.circuitBreaker(check.kind);
      if (!registration) {
        await emit({
          type: "circuitBreaker.error",
          iteration,
          message: `Circuit breaker check '${check.kind}' is not registered.`,
        });
        continue;
      }
      let signature: string | null;
      try {
        signature = await registration.callback({
          kind: check.kind,
          workspace: plan.workspace,
          iteration,
          expand: (value) => this.expander.expand(value, values),
          lastFailure,
        });
      } catch (error) {
        await emit({
          type: "circuitBreaker.error",
          iteration,
          message: this.message(error),
        });
        continue;
      }
      const evaluation = await evaluateCircuitBreaker(
        plan.workspace,
        check.kind,
        check.threshold,
        signature,
      );
      if (evaluation.signature === null) {
        await emit({
          type: "circuitBreaker.reset",
          iteration,
          message: `Circuit breaker '${check.kind}' reset.`,
        });
        continue;
      }
      if (!evaluation.tripped) {
        await emit({
          type: "circuitBreaker.streak",
          iteration,
          message: `Circuit breaker '${check.kind}' streak ${evaluation.streak}/${check.threshold} (${evaluation.signature}).`,
        });
        continue;
      }
      await emit({
        type: "circuitBreaker.tripped",
        iteration,
        message: `Circuit breaker '${check.kind}' tripped after ${evaluation.streak} consecutive occurrences of '${evaluation.signature}' (threshold ${check.threshold}).`,
      });
      return `Circuit breaker '${check.kind}' tripped: '${evaluation.signature}' repeated ${evaluation.streak} times (threshold ${check.threshold}).`;
    }
    return null;
  }

  private async continueWhenEmpty(
    plan: WorkflowPlan,
    iteration: number,
    events: WorkflowEvent[],
    options: WorkflowOptions,
  ): Promise<WorkflowRunResult | null> {
    const c = plan.continuation;
    if (!c)
      return this.result(
        "complete",
        "No unchecked tasks remain.",
        iteration - 1,
        events,
      );
    if (c.kind !== "blueprint" || !c.seedPrdFromSource || !c.source)
      return c.kind === "blueprint" && !c.completeWhenSourceExhausted
        ? this.result(
            "blocked",
            "Blueprint source exhausted.",
            iteration - 1,
            events,
          )
        : this.result(
            "complete",
            "No unchecked tasks remain.",
            iteration - 1,
            events,
          );
    try {
      const line = await this.source.seedBlueprintTask(
        plan.tasks.prd,
        c.source,
      );
      if (line) {
        await events.push({
          type: "continuation.seeded",
          iteration: iteration - 1,
          message: `Seeded task from blueprint: ${line}`,
        });
        return null;
      }
    } catch (error) {
      return this.result("blocked", this.message(error), iteration - 1, events);
    }
    return c.completeWhenSourceExhausted
      ? this.result(
          "complete",
          "Blueprint source exhausted.",
          iteration - 1,
          events,
        )
      : this.result(
          "blocked",
          "Blueprint source exhausted.",
          iteration - 1,
          events,
        );
  }
  private async continueAfterTask(
    plan: WorkflowPlan,
    values: PlaceholderContext,
    iteration: number,
    events: WorkflowEvent[],
    options: WorkflowOptions,
  ): Promise<WorkflowRunResult | null> {
    const c = plan.continuation;
    if (
      !c ||
      c.kind !== "generatedGoal" ||
      !c.producer ||
      !c.completeWhen ||
      !c.nextTask
    )
      return null;
    const produced = await this.runStage(
      plan,
      c.producer,
      values,
      plan.workspace,
      iteration,
      async (e) => {
        events.push(e);
        await this.callbacks.onEvent?.(e);
      },
      options.signal,
    );
    if (!produced.success)
      return this.failure(produced.result, iteration, events);
    const predicate = this.extensions.predicate(c.completeWhen.kind);
    if (!predicate)
      return this.result(
        "blocked",
        `Predicate '${c.completeWhen.kind}' is not registered.`,
        iteration,
        events,
      );
    const complete = await predicate.callback({
      path: c.completeWhen.path,
      check: c.completeWhen.check,
      expand: (value) => this.expander.expand(value, values),
      runStage: (stage) =>
        this.runStage(
          plan,
          stage,
          values,
          plan.workspace,
          iteration,
          async (e) => {
            events.push(e);
            await this.callbacks.onEvent?.(e);
          },
          options.signal,
        ),
    });
    if (complete)
      return this.result(
        "complete",
        "Completion predicate matched.",
        iteration,
        events,
      );
    try {
      await this.source.scheduleTask(
        plan.tasks.prd,
        this.expander.expand(c.nextTask, values),
      );
    } catch (error) {
      return this.result("blocked", this.message(error), iteration, events);
    }
    events.push({
      type: "continuation.seeded",
      iteration,
      message: "Generated task scheduled.",
    });
    return null;
  }
}
