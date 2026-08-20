import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StagePlan, WorkflowPlan } from "../config/compiler.js";
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
import {
  defaultExtensionRegistry,
  type ExtensionRegistry,
} from "../extensions/registry.js";

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
          if (continuation) return continuation;
          continue;
        }
        const original = task;
        let values = this.values(plan, task, options, iteration);
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
              failure.result,
              iteration,
              emit,
            );
            if (handled) return handled;
          }
          try {
            task = await this.source.getFirstUncheckedTask(plan.tasks.prd);
          } catch (error) {
            return this.result(
              "blocked",
              this.message(error),
              iteration,
              events,
            );
          }
          if (!task)
            return this.result(
              "complete",
              "No unchecked tasks remain.",
              iteration,
              events,
            );
          values = this.values(plan, task, options, iteration);
        }
        let run = await this.runStage(
          harness,
          values,
          workspace,
          iteration,
          emit,
          options.signal,
        );
        if (!run.success) return this.failure(run.result, iteration, events);
        try {
          task = await this.source.getFirstUncheckedTask(plan.tasks.prd);
        } catch (error) {
          return this.result("blocked", this.message(error), iteration, events);
        }
        values = task ? this.values(plan, task, options, iteration) : values;
        for (const stage of plan.postAgent) {
          run = await this.runStage(
            stage,
            values,
            workspace,
            iteration,
            emit,
            options.signal,
          );
          if (!run.success) {
            const handled = await this.handleFailure(
              plan,
              stage,
              values,
              run.result,
              iteration,
              emit,
            );
            if (handled) return handled;
            try {
              task = await this.source.getFirstUncheckedTask(plan.tasks.prd);
            } catch (error) {
              return this.result(
                "blocked",
                this.message(error),
                iteration,
                events,
              );
            }
            values = task
              ? this.values(plan, task, options, iteration)
              : values;
          }
        }
        if (
          plan.verification.requireTaskChecked &&
          (await this.stillUnchecked(plan.tasks.prd, original))
        ) {
          for (let retry = 0; retry < plan.verification.retries; retry++) {
            let verifyValues = this.values(plan, original, options, iteration);
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
              harness,
              verifyValues,
              workspace,
              iteration,
              emit,
              options.signal,
            );
            if (!run.success)
              return this.failure(run.result, iteration, events);
            if (!(await this.stillUnchecked(plan.tasks.prd, original))) break;
          }
          if (await this.stillUnchecked(plan.tasks.prd, original))
            return this.result(
              "blocked",
              `Task ${original.id} remained unchecked after verification.`,
              iteration,
              events,
            );
        }
        const continuation = await this.continueAfterTask(
          plan,
          values,
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
    const task = await this.source.getFirstUncheckedTask(path);
    return (
      task?.id.toLowerCase() === target.id.toLowerCase() &&
      task.rawLine === target.rawLine
    );
  }
  private async runStage(
    stage: StagePlan,
    values: PlaceholderContext,
    workspace: string,
    iteration: number,
    emit: (e: WorkflowEvent) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const args = this.expander.expandArguments(stage, values);
    const env = Object.fromEntries(
      stage.environment.map((x) => [
        x.name,
        { value: this.expander.expand(x.value, values), secret: x.secret },
      ]),
    );
    await emit({
      type: "stage.started",
      iteration,
      stage: stage.name,
      message: "Stage started.",
    });
    let result: ProcessResult;
    try {
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
      });
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
    await emit({
      type: "stage.completed",
      iteration,
      stage: stage.name,
      message: result.cancelled
        ? "Stage canceled."
        : success
          ? "Stage succeeded."
          : result.timedOut
            ? "Stage timed out."
            : `Stage exited with code ${result.exitCode}.`,
    });
    return { result, success };
  }
  private async handleFailure(
    plan: WorkflowPlan,
    stage: StagePlan,
    values: PlaceholderContext,
    result: ProcessResult,
    iteration: number,
    emit: (e: WorkflowEvent) => Promise<void>,
  ): Promise<WorkflowRunResult | null> {
    if (stage.failureAction || stage.failureTask) {
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
      // A failure task was scheduled — continue the loop so it gets processed.
      return null;
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
