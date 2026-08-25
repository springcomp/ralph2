import type { WorkflowEvent, WorkflowRunResult } from "./engine.js";
import type {
  CoreContext,
  Outcome,
  Policy,
  Step,
  StepFailure,
} from "./plan.js";

export interface PipelineContext extends CoreContext {
  readonly emit?: (event: WorkflowEvent) => Promise<void>;
  readonly schedule?: (
    policy: Extract<Policy, { kind: "schedule" }>,
    failure: StepFailure,
  ) => Promise<"scheduled" | WorkflowRunResult>;
}

const failureOutcome = (
  failure: StepFailure,
  canceled = false,
): Extract<Outcome, { terminal: true }> => ({
  terminal: true,
  status: canceled ? "canceled" : "processFailure",
  message: canceled
    ? "Canceled."
    : failure.result.process?.timedOut
      ? "Process timed out."
      : `Process exited with code ${failure.result.process?.exitCode ?? null}.`,
  lastFailure: failure,
});

export async function run(
  steps: readonly Step[],
  ctx: PipelineContext,
  iteration: number,
): Promise<Outcome> {
  let lastFailure: StepFailure | null = null;
  let scheduled = false;
  for (const step of steps) {
    const policy = step.onFail;
    const attempts =
      policy.kind === "retry" ? Math.max(0, policy.times) + 1 : 1;
    let result = await step.run(ctx);
    for (let attempt = 1; !result.success && attempt < attempts; attempt++) {
      if (policy.kind !== "retry" || !(await policy.predicate.check(ctx)))
        break;
      result = await step.run(ctx);
    }
    if (result.success) continue;
    const failure: StepFailure = { step, result };
    lastFailure = failure;
    if (policy.kind === "continue") {
      await ctx.emit?.({
        type: "stage.continued",
        iteration,
        stage: step.name,
        message: "Continuing after stage failure.",
      });
      continue;
    }
    if (policy.kind === "retry") {
      return {
        terminal: true,
        status: "blocked",
        message: "Task remained unchecked.",
        lastFailure: failure,
      };
    }
    if (policy.kind === "schedule") {
      if (!ctx.schedule)
        return {
          terminal: true,
          status: "blocked",
          message: `Action '${policy.action}' is not available.`,
          lastFailure: failure,
        };
      const scheduledResult = await ctx.schedule(policy, failure);
      if (scheduledResult !== "scheduled") return scheduledResult as never;
      scheduled = true;
      break;
    }
    return failureOutcome(
      failure,
      result.process?.cancelled === true || ctx.signal?.aborted === true,
    );
  }
  return { terminal: false, lastFailure, scheduled };
}
