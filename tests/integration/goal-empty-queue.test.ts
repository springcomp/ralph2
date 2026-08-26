import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("generated goal empty queue integration", () => {
  it("seeds, processes, and completes one initial goal without queue mutation by the harness", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-goal-empty-queue-"));
    temporaryDirectories.push(workspace);
    const queuePath = join(workspace, "queue.md");
    await writeFile(queuePath, "# Task Queue\n\n", "utf8");
    await writeFile(
      join(workspace, "prompt.md"),
      "Implement the assigned task.\n",
      "utf8",
    );

    const source = new MarkdownTaskSource(queuePath);
    const scheduleTask = vi.spyOn(source, "scheduleTask");
    const sequence: string[] = [];
    const runner: ProcessRunner & { requests: ProcessRequest[] } = {
      requests: [],
      async run(request) {
        this.requests.push(request);
        if (this.requests.length === 1) {
          sequence.push("harness");
          const prompt = request.args?.[0];
          if (!prompt) throw new Error("Harness prompt path was not provided.");
          expect(await readFile(prompt, "utf8")).toContain(
            "Task: - [ ] GOAL-001 - Define first goal",
          );
        } else if (this.requests.length === 2) {
          sequence.push("producer");
          expect(await source.getFirstUncheckedTask()).toBeNull();
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
          queue: "queue.md",
          progress: "progress.txt",
          prompt: "prompt.md",
          completionSignal: "",
          completion: "engine",
        },
        defaults: { harness: "fake", statusFormat: "{TASK}" },
        harnesses: {
          fake: { executable: "fake-harness", arguments: ["{PROMPT}"] },
        },
        continuation: {
          kind: "generatedGoal",
          producer: { executable: "fake-producer" },
          completeWhen: { kind: "fileMissing", path: "missing.marker" },
          seedTask: "- [ ] GOAL-001 - Define first goal",
          nextTask: "- [ ] GOAL-{ITERATION:000} - Resolve remaining failures",
        },
        verification: { requireTaskChecked: false, retries: 0 },
      },
      workspace,
      source,
      {},
      defaultExtensionRegistry,
    );

    const result = await new CoreEngine(runner, source).run(core);

    expect(result.status).toBe("complete");
    expect(result.iterations).toBe(1);
    expect(scheduleTask).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(["harness", "producer"]);
    expect(
      result.events.filter((event) => event.type === "task.started"),
    ).toHaveLength(1);
    expect(result.events.some((event) => event.type === "stage.started")).toBe(
      true,
    );
    expect(runner.requests.map((request) => request.command)).toEqual([
      "fake-harness",
      "fake-producer",
    ]);
    expect(await readFile(queuePath, "utf8")).toContain(
      "- [x] GOAL-001 - Define first goal",
    );
  });
});
