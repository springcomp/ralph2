import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compiler.js";
import { parseWorkflowYaml } from "../../src/config/validator.js";
import { WorkflowEngine } from "../../src/core/engine.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/core/process-runner.js";

const success = (): ProcessResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
});

class FakeCodingAgent implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  private buildInvocations = 0;
  private producerInvocations = 0;

  constructor(
    private readonly prdPath: string,
    private readonly markerPath: string,
    private readonly completionProducerInvocation = 2,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);

    if (request.command === "coding-agent") {
      const prompt = this.argument(request, "--prompt");
      const prd = await readFile(this.prdPath, "utf8");
      const unchecked = prd.match(/- \[ \] ([^\n]+)/)?.[1];
      if (!prompt || !unchecked)
        throw new Error("coding-agent received no task");
      await writeFile(this.prdPath, prd.replace("- [ ]", "- [x]"), "utf8");
      return success();
    }

    if (request.command === "build") {
      this.buildInvocations++;
      return this.buildInvocations === 1
        ? { ...success(), exitCode: 1 }
        : success();
    }

    if (request.command === "check-goal") {
      this.producerInvocations++;
      const prd = await readFile(this.prdPath, "utf8");
      const fixCompleted = /- \[x\] FIX-/.test(prd);
      if (
        (this.buildInvocations > 0 && fixCompleted) ||
        (this.buildInvocations === 0 &&
          this.producerInvocations >= this.completionProducerInvocation)
      )
        await rm(this.markerPath, { force: true });
      return success();
    }

    throw new Error(`Unexpected fake process: ${request.command}`);
  }

  private argument(request: ProcessRequest, name: string): string | undefined {
    const index = request.args?.indexOf(name) ?? -1;
    return index >= 0 ? request.args?.[index + 1] : undefined;
  }
}

describe("goal workflow integration", () => {
  let workspace: string;
  let prdPath: string;
  let markerPath: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ralph-goal-integration-"));
    prdPath = join(workspace, "PRD.md");
    markerPath = join(workspace, "remaining-failures.log");
    await writeFile(prdPath, "- [ ] GOAL-001 - First step\n", "utf8");
    await writeFile(join(workspace, "progress.txt"), "", "utf8");
    await writeFile(join(workspace, "prompt.md"), "Do the task", "utf8");
    await writeFile(markerPath, "remaining", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const createPlan = (
    postAgent = "",
    continuation = true,
  ): ReturnType<typeof compileWorkflow> => {
    const continuationYaml = continuation
      ? `continuation:
  kind: generatedGoal
  producer:
    executable: check-goal
  completeWhen:
    kind: fileMissing
    path: remaining-failures.log
  nextTask: "- [ ] GOAL-{ITERATION:000} - Next step"`
      : "";
    return compileWorkflow(
      parseWorkflowYaml(`
schemaVersion: 1
workspace: .
maxIterations: 5
tasks:
  prd: PRD.md
  progress: progress.txt
  prompt: prompt.md
defaults:
  harness: coding-agent
  model: test-model
  agent: test-agent
harnesses:
  coding-agent:
    executable: coding-agent
    arguments: [--model, "{MODEL}", --prompt, "{PROMPT}"]
${postAgent ? `postAgent:\n${postAgent}` : "postAgent: []"}
${continuationYaml}
verification:
  requireTaskChecked: false
`),
      workspace,
    );
  };

  it("completes a two-step goal with no pre- or post-agent tasks", async () => {
    const runner = new FakeCodingAgent(prdPath, markerPath);
    const plan = createPlan();
    const result = await new WorkflowEngine(runner).run(plan);

    expect(result.status).toBe("complete");
    expect(
      runner.requests.filter(({ command }) => command === "coding-agent"),
    ).toHaveLength(2);
    expect(
      runner.requests.filter(({ command }) => command === "build"),
    ).toHaveLength(0);
    expect((await readFile(prdPath, "utf8")).match(/- \[x\]/g)).toHaveLength(2);
    await expect(readFile(markerPath, "utf8")).rejects.toThrow();
  });

  it("schedules and fixes a post-agent build failure once", async () => {
    await writeFile(
      prdPath,
      "- [ ] GOAL-001 - First step\n- [ ] GOAL-002 - Second step\n",
      "utf8",
    );
    const runner = new FakeCodingAgent(prdPath, markerPath);
    const plan = createPlan(
      `  - name: build\n    executable: build\n    failurePolicy: continue\n    onFailure:\n      action: scheduleTask\n      task: "- [ ] FIX-{ITERATION:000} - Fix build"`,
      false,
    );
    const events: string[] = [];
    const result = await new WorkflowEngine(runner, undefined, undefined, {
      onEvent: (event) => {
        events.push(event.type);
      },
    }).run(plan);

    expect(result.status).toBe("complete");
    expect(
      runner.requests.filter(({ command }) => command === "build"),
    ).toHaveLength(3);
    expect(events.filter((type) => type === "fix.scheduled")).toHaveLength(1);
    const prd = await readFile(prdPath, "utf8");
    expect(prd).toContain("- [x] FIX-001 - Fix build");
    expect(prd.match(/- \[x\]/g)).toHaveLength(3);
  });
});
