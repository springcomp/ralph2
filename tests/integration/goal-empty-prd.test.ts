import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileCore } from "../../src/config/compiler.js";
import { CoreEngine } from "../../src/core/engine-core.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/core/process-runner.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

const temporaryDirectories: string[] = [];
const success: ProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("generated goal empty PRD integration", () => {
  it("seeds, processes, and completes one initial goal without a second seed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-goal-empty-prd-"));
    temporaryDirectories.push(workspace);
    const prdPath = join(workspace, "PRD.md");
    await writeFile(prdPath, "# Product Requirements\n\n", "utf8");
    await writeFile(
      join(workspace, "prompt.md"),
      "Implement the assigned task.\n",
      "utf8",
    );

    const source = new MarkdownTaskSource(prdPath);
    const runner: ProcessRunner & { requests: ProcessRequest[] } = {
      requests: [],
      async run(request) {
        this.requests.push(request);
        if (this.requests.length === 1) {
          const task = await source.getFirstUncheckedTask();
          if (!task)
            throw new Error("Seed task was not visible to the harness.");
          await source.checkTask(task);
        }
        return success;
      },
    };
    const core = compileCore(
      {
        schemaVersion: 1,
        workspace: ".",
        maxIterations: 3,
        tasks: {
          format: "markdown",
          prd: "PRD.md",
          progress: "progress.txt",
          prompt: "prompt.md",
          completionSignal: "",
        },
        defaults: { harness: "fake", statusFormat: "{TASK}" },
        harnesses: { fake: { executable: "fake-harness" } },
        continuation: {
          kind: "generatedGoal",
          producer: { executable: "fake-producer" },
          completeWhen: { kind: "fileMissing", path: "missing.marker" },
          seedTask: "- [ ] GOAL-001 - Define first goal",
          nextTask: "- [ ] GOAL-{ITERATION:000} - Resolve remaining failures",
        },
        verification: { requireTaskChecked: true, retries: 0 },
      },
      workspace,
      source,
      {},
      defaultExtensionRegistry,
    );

    const result = await new CoreEngine(runner, source).run(core);

    expect(result.status).toBe("complete");
    expect(result.iterations).toBe(1);
    expect(
      result.events.filter((event) => event.type === "task.started"),
    ).toHaveLength(1);
    expect(result.events.some((event) => event.stage === "verify")).toBe(true);
    expect(runner.requests.map((request) => request.command)).toEqual([
      "fake-harness",
      "fake-harness",
      "fake-producer",
    ]);
    expect(await readFile(prdPath, "utf8")).toContain(
      "- [x] GOAL-001 - Define first goal",
    );
  });
});
