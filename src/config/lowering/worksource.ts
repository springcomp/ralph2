import type { CoreContext, WorkSource } from "../../core/plan.js";
import type { Task, TaskDocumentReader, TaskSource } from "../../core/task.js";
import { MarkdownTaskDocumentReader } from "../../task-source/markdown-task-source.js";
import type { ExtensionRegistry } from "../../extensions/registry.js";
import type { WorkflowPlan } from "../compiler.js";

export class PrdSource implements WorkSource {
  constructor(private readonly source: TaskSource) {}
  pull(): Promise<Task | null> {
    return this.source.getFirstUncheckedTask();
  }
}

export class BlueprintRefill implements WorkSource {
  constructor(
    private readonly source: TaskSource,
    private readonly blueprintPath: string,
  ) {}
  async pull(): Promise<Task | null> {
    await this.source.seedBlueprintTask(this.blueprintPath);
    return this.source.getFirstUncheckedTask();
  }
}

export class ChainedWorkSource implements WorkSource {
  private index = 0;
  constructor(
    private readonly sources: readonly WorkSource[],
    private readonly exhausted: "complete" | "blocked" = "complete",
    readonly blockedMessage?: string,
  ) {}
  get completionStatus(): "complete" | "blocked" {
    return this.exhausted;
  }
  async pull(iteration: number): Promise<Task | null> {
    while (this.index < this.sources.length) {
      const task = await this.sources[this.index].pull(iteration);
      if (task) return task;
      this.index++;
    }
    return null;
  }
  reset(): void {
    this.index = 0;
  }
}

export class GeneratorWorkSource implements WorkSource {
  constructor(
    private readonly base: WorkSource,
    private readonly producer: import("../../config/compiler.js").StagePlan,
    private readonly completeWhen: NonNullable<
      NonNullable<WorkflowPlan["continuation"]>["completeWhen"]
    >,
    private readonly nextTask: string,
    private readonly source: TaskSource,
    private readonly plan: WorkflowPlan,
    private readonly extensions: ExtensionRegistry,
    private readonly seedTask?: string,
  ) {}
  private initialPullCompleted = false;

  async pull(iteration: number): Promise<Task | null> {
    const task = await this.base.pull(iteration);
    if (this.initialPullCompleted || iteration !== 1) return task;
    this.initialPullCompleted = true;
    if (task || this.seedTask === undefined) return task;

    await this.source.scheduleTask(this.seedTask);
    return this.base.pull(iteration);
  }
  async afterTask(ctx: CoreContext): Promise<void> {
    const runtime = ctx as CoreContext & {
      runStage: (
        stage: import("../../config/compiler.js").StagePlan,
        ctx: CoreContext,
      ) => Promise<{ success: boolean }>;
      expand: (value: string) => string;
    };
    const produced = await runtime.runStage(this.producer, ctx);
    if (!produced.success) throw new Error("Goal producer failed.");
    const registration = this.extensions.predicate(this.completeWhen.kind);
    if (!registration)
      throw new Error(
        `Predicate '${this.completeWhen.kind}' is not registered.`,
      );
    const complete = await registration.callback({
      path: this.completeWhen.path,
      check: this.completeWhen.check,
      expand: runtime.expand,
      runStage: (stage) => runtime.runStage(stage, ctx),
    });
    if (!complete)
      await this.source.scheduleTask(runtime.expand(this.nextTask));
  }
}

export class TriggerWorkSource implements WorkSource {
  constructor(
    private readonly inner: WorkSource,
    private readonly config: NonNullable<WorkflowPlan["trigger"]>,
    private readonly source: TaskSource,
    private readonly observedSource: TaskDocumentReader,
    private readonly plan: WorkflowPlan,
    private readonly extensions: ExtensionRegistry,
  ) {}
  get completionStatus(): "complete" | "blocked" {
    return this.inner.completionStatus ?? "complete";
  }
  async pull(iteration: number): Promise<Task | null> {
    const task = await this.inner.pull(iteration);
    if (task) return task;
    const registration = this.extensions.trigger(this.config.kind);
    if (!registration)
      throw new Error(`Trigger '${this.config.kind}' is not registered.`);
    const signal = await registration.callback({
      kind: this.config.kind,
      source: this.config.source,
      pollIntervalMs: this.config.pollIntervalMs,
      workspace: this.plan.workspace,
      taskSource: this.source,
      observedSource: this.observedSource,
      expand: (v) => v,
      signal: undefined,
      emit: async () => undefined,
    });
    if (!signal) return null;
    this.inner.reset?.();
    return this.inner.pull(iteration);
  }
}

export function lowerWorkSource(
  plan: WorkflowPlan,
  source: TaskSource,
  extensions: ExtensionRegistry,
  observedSource?: TaskDocumentReader,
): WorkSource {
  const base = new PrdSource(source);
  let result: WorkSource = base;
  const continuation = plan.continuation;
  if (continuation) {
    const lowering = extensions.continuationLowering(continuation.kind);
    if (!lowering)
      throw new Error(`Continuation '${continuation.kind}' is not registered.`);
    result = lowering.lower(continuation, {
      plan,
      source,
      extensions,
      base: result,
    });
  }
  if (plan.trigger) {
    const observedReader =
      observedSource ?? new MarkdownTaskDocumentReader(plan.trigger.source);
    const lowering = extensions.triggerLowering(plan.trigger.kind);
    if (!lowering)
      throw new Error(`Trigger '${plan.trigger.kind}' is not registered.`);
    result = lowering.lower(plan.trigger, {
      plan,
      source,
      observedSource: observedReader,
      extensions,
      inner: result,
    });
  }
  return result;
}
