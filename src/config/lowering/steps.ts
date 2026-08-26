import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEnvFile } from "../../core/env-file.js";
import { readTextFile } from "../../core/file-io.js";
import type {
  CoreContext,
  Policy,
  Predicate,
  Step,
  StepResult,
} from "../../core/plan.js";
import type { ProcessRunner } from "../../core/process-runner.js";
import type { TaskSource } from "../../core/task.js";
import {
  type PlaceholderContext,
  PlaceholderExpander,
} from "../../placeholders/placeholders.js";
import type { StagePlan, WorkflowPlan } from "../compiler.js";

type RuntimeContext = CoreContext & {
  runner: ProcessRunner;
  expander: PlaceholderExpander;
  plan: WorkflowPlan;
  harnessPrompt?: boolean;
  emit?: (event: {
    type: string;
    iteration: number;
    stage?: string;
    message: string;
  }) => Promise<void>;
};

const values = (ctx: CoreContext): PlaceholderContext => {
  const task = ctx.task;
  return {
    model: typeof ctx.model === "string" ? ctx.model : null,
    agent: typeof ctx.agent === "string" ? ctx.agent : null,
    type: task.typ,
    number: task.num,
    task: task.description,
    taskLine: task.rawLine,
    root: typeof ctx.root === "string" ? ctx.root : `${task.typ}-${task.num}`,
    prompt: typeof ctx.prompt === "string" ? ctx.prompt : null,
    queue: typeof ctx.queue === "string" ? ctx.queue : null,
    goal: typeof ctx.goal === "string" ? ctx.goal : null,
    prd: typeof ctx.prd === "string" ? ctx.prd : null,
    progress: typeof ctx.progress === "string" ? ctx.progress : null,
    iteration: ctx.iteration,
    workspace: ctx.workspace,
  };
};

export async function runStage(
  stage: StagePlan,
  ctx: RuntimeContext,
): Promise<StepResult> {
  const v = values(ctx);
  const { runner, expander, plan } = ctx;
  let stageValues = v;
  await ctx.emit?.({
    type: "stage.started",
    iteration: ctx.iteration,
    stage: stage.name,
    message: "Stage started.",
  });
  try {
    if (ctx.harnessPrompt) {
      const promptPath = join(
        plan.workspace,
        ".agentic",
        "__harness.prompt.md",
      );
      const sourcePrompt = plan.tasks.prompt
        ? await readTextFile(plan.tasks.prompt)
        : "";
      const goal = plan.goalPath ? `Goal: ${plan.goalPath}\n` : "";
      const generated = [
        "# Assigned task",
        `Task ID: ${ctx.task.id}`,
        `Task: ${ctx.task.rawLine}`,
        goal.trimEnd(),
        `Progress: ${plan.tasks.progress}`,
        "Ownership: You own this assigned task. Do not select, reorder, or mutate the task queue; implement the assignment and leave verification to the workflow.",
        "",
        sourcePrompt,
      ]
        .filter((line, index) => index !== 3 || line.length > 0)
        .join("\n");
      await mkdir(dirname(promptPath), { recursive: true });
      await writeFile(promptPath, generated, "utf8");
      stageValues = { ...v, prompt: promptPath };
    } else if (stage.name === "verify" && plan.verification.prompt) {
      const promptPath = join(
        plan.workspace,
        ".agentic",
        "__verification.prompt.md",
      );
      await mkdir(dirname(promptPath), { recursive: true });
      await writeFile(
        promptPath,
        expander.expand(plan.verification.prompt, v),
        "utf8",
      );
      stageValues = { ...v, prompt: promptPath };
    }
  } catch (error) {
    const message = `Prompt materialization failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await ctx.emit?.({
      type: "stage.completed",
      iteration: ctx.iteration,
      stage: stage.name,
      message,
    });
    return { success: false, message };
  }
  const env: Record<string, { value: string; secret: boolean }> = {};
  for (const file of [plan.envFilePath, stage.envFilePath]) {
    if (!file) continue;
    for (const [name, value] of Object.entries(await loadEnvFile(file)))
      env[name] = { value, secret: false };
  }
  for (const item of [...(plan.environment ?? []), ...stage.environment])
    env[item.name] = {
      value: expander.expand(item.value, stageValues),
      secret: item.secret,
    };
  const result = await runner.run({
    command: expander.expand(stage.executable, stageValues),
    args: expander.expandArguments(stage, stageValues),
    cwd: plan.workspace,
    env,
    outputPath: stage.outputPath
      ? expander.expand(stage.outputPath, stageValues)
      : undefined,
    timeoutMs: stage.timeoutMs,
    signal: ctx.signal,
    usePty: stage.pty,
  });
  const success =
    !result.timedOut &&
    !result.cancelled &&
    result.exitCode !== null &&
    stage.successExitCodes.includes(result.exitCode);
  const artifactFailure =
    success && stage.resultRequired
      ? !(await validateArtifact(stage, stageValues, expander))
      : false;
  await ctx.emit?.({
    type: "stage.completed",
    iteration: ctx.iteration,
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
  return { success: success && !artifactFailure, process: result };
}

async function validateArtifact(
  stage: StagePlan,
  v: PlaceholderContext,
  expander: PlaceholderExpander,
): Promise<boolean> {
  if (!stage.resultPath) return false;
  try {
    const parsed: unknown = JSON.parse(
      await readTextFile(expander.expand(stage.resultPath, v)),
    );
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT")
    )
      return false;
    throw error;
  }
}

const taskUnchecked = (source: TaskSource): Predicate => ({
  async check(ctx) {
    const runtime = ctx as CoreContext & {
      task: import("../../core/task.js").Task;
      source: TaskSource;
    };
    return source.isTaskUnchecked(runtime.task);
  },
});

function policy(stage: StagePlan, plan: WorkflowPlan): Policy {
  if (stage.failureAction || stage.failureTask)
    return {
      kind: "schedule",
      action: stage.failureAction ?? "scheduleTask",
      maxAttempts: plan.maxRemediationAttempts,
    };
  if (stage.failurePolicy === "continue" || stage.mandatory === false)
    return { kind: "continue" };
  return { kind: "stop" };
}

export function lowerSteps(
  plan: WorkflowPlan,
  source: TaskSource,
  expander = new PlaceholderExpander(),
): Step[] {
  const harness = plan.harnesses[plan.defaultHarness];
  if (!harness)
    throw new Error(`Harness '${plan.defaultHarness}' is not configured.`);
  const make = (
    stage: StagePlan,
    role: Step["role"],
    override?: Policy,
  ): Step => ({
    name: stage.name,
    role,
    onFail: override ?? policy(stage, plan),
    stage,
    run: (ctx) =>
      runStage(stage, {
        ...ctx,
        runner: (ctx as RuntimeContext).runner,
        expander,
        plan,
        harnessPrompt: role === "harness",
      } as RuntimeContext),
  });
  const steps = plan.preAgent.map((stage) => make(stage, "pre"));
  steps.push(make(harness, "harness"));
  steps.push(...plan.postAgent.map((stage) => make(stage, "post")));
  if (plan.verification.requireTaskChecked) {
    const predicate = taskUnchecked(source);
    const verify = { ...harness, name: "verify" };
    const verifyStep = make(verify, "verify", {
      kind: "retry",
      predicate,
      times: plan.verification.retries,
    });
    const runVerify = verifyStep.run;
    verifyStep.run = async (ctx) => {
      // Verification is only needed when agent work left its assigned task
      // unchecked. Do not invoke a second harness after task completion.
      if (!(await source.isTaskUnchecked(ctx.task))) return { success: true };
      const result = await runVerify(ctx);
      if (result.success && (await source.isTaskUnchecked(ctx.task)))
        return {
          ...result,
          success: false,
          message: "Task remains unchecked.",
        };
      return result;
    };
    steps.push(verifyStep);
  }
  return steps;
}
