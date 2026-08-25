import type { CoreContext, WorkSource } from "../../core/plan.js";
import type { Task, TaskSource } from "../../core/task.js";
import type { ExtensionRegistry } from "../../extensions/registry.js";
import type { WorkflowPlan } from "../compiler.js";

export class PrdSource implements WorkSource {
  constructor(
    private readonly source: TaskSource,
    private readonly prdPath: string,
  ) {}
  pull(): Promise<Task | null> {
    return this.source.getFirstUncheckedTask(this.prdPath);
  }
}

export class BlueprintRefill implements WorkSource {
  constructor(
    private readonly source: TaskSource,
    private readonly prdPath: string,
    private readonly blueprintPath: string,
  ) {}
  async pull(): Promise<Task | null> {
    await this.source.seedBlueprintTask(this.prdPath, this.blueprintPath);
    return this.source.getFirstUncheckedTask(this.prdPath);
  }
}

export class ChainedWorkSource implements WorkSource {
  private index = 0;
  constructor(
    private readonly sources: readonly WorkSource[],
    private readonly exhausted: "complete" | "blocked" = "complete",
  ) {}
  async pull(iteration: number): Promise<Task | null> {
    while (this.index < this.sources.length) {
      const task = await this.sources[this.index].pull(iteration);
      if (task) return task;
      this.index++;
    }
    return null;
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
  ) {}
  pull(iteration: number): Promise<Task | null> {
    return this.base.pull(iteration);
  }
  async afterTask(ctx: CoreContext): Promise<void> {
    const runtime = ctx as CoreContext & {
      runStage: (
        stage: import("../../config/compiler.js").StagePlan,
      ) => Promise<{ success: boolean }>;
      expand: (value: string) => string;
    };
    const produced = await runtime.runStage(this.producer);
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
      runStage: runtime.runStage,
    });
    if (!complete)
      await this.source.scheduleTask(
        this.plan.tasks.prd,
        runtime.expand(this.nextTask),
      );
  }
}

export class TriggerWorkSource implements WorkSource {
  constructor(
    private readonly inner: WorkSource,
    private readonly config: NonNullable<WorkflowPlan["trigger"]>,
    private readonly source: TaskSource,
    private readonly plan: WorkflowPlan,
    private readonly extensions: ExtensionRegistry,
  ) {}
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
      expand: (v) => v,
      signal: undefined,
      emit: async () => undefined,
    });
    return signal ? this.inner.pull(iteration) : null;
  }
}

export function lowerWorkSource(
  plan: WorkflowPlan,
  source: TaskSource,
  extensions: ExtensionRegistry,
): WorkSource {
  const base = new PrdSource(source, plan.tasks.prd);
  const continuation = plan.continuation;
  let result: WorkSource =
    continuation?.kind === "blueprint" &&
    continuation.source &&
    continuation.seedPrdFromSource
      ? new ChainedWorkSource([
          base,
          new BlueprintRefill(source, plan.tasks.prd, continuation.source),
        ])
      : base;
  if (
    continuation?.kind === "generatedGoal" &&
    continuation.producer &&
    continuation.completeWhen &&
    continuation.nextTask
  )
    result = new GeneratorWorkSource(
      result,
      continuation.producer,
      continuation.completeWhen,
      continuation.nextTask,
      source,
      plan,
      extensions,
    );
  if (plan.trigger)
    result = new TriggerWorkSource(
      result,
      plan.trigger,
      source,
      plan,
      extensions,
    );
  return result;
}
