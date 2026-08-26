import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowPlan } from "../../src/config/compiler.js";
import { lowerWorkSource } from "../../src/config/lowering/worksource.js";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("blueprint watcher integration", () => {
  it("waits for a new blueprint task and processes it with a fake runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-blueprint-watcher-"));
    temporaryDirectories.push(workspace);
    const prdPath = join(workspace, "PRD.md");
    const blueprintPath = join(workspace, "BLUEPRINT.md");
    await writeFile(prdPath, "# Product Requirements\n\n", "utf8");
    await writeFile(
      blueprintPath,
      "# Blueprint\n\n- [ ] TASK-001 - Initial task\n",
      "utf8",
    );

    const plan = {
      workspace,
      tasks: {
        prd: prdPath,
        progress: join(workspace, "progress.txt"),
        prompt: join(workspace, "prompt.md"),
        completionSignal: "",
      },
      continuation: {
        kind: "blueprint",
        source: blueprintPath,
        seedPrdFromSource: true,
        completeWhenSourceExhausted: true,
      },
      trigger: {
        kind: "taskAppears",
        source: blueprintPath,
        pollIntervalMs: 5,
      },
    } as WorkflowPlan;
    const source = new MarkdownTaskSource();
    const runner = new FakeProcessRunner();
    const workflow = lowerWorkSource(plan, source, defaultExtensionRegistry);

    const firstTask = await workflow.pull(1);
    expect(firstTask?.id).toBe("TASK-001");
    if (!firstTask) throw new Error("Initial blueprint task was not seeded.");
    await runner.run({ command: "fake-llm", args: [firstTask.id] });
    await source.checkTask(prdPath, firstTask);
    expect(await source.getFirstUncheckedTask(prdPath)).toBeNull();
    expect(await readFile(blueprintPath, "utf8")).toContain("- [x] TASK-001");

    const waitingForTask = workflow.pull(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendFile(
      blueprintPath,
      "- [ ] TASK-002 - Task added while watcher is idle\n",
      "utf8",
    );

    const secondTask = await waitingForTask;
    expect(secondTask?.id).toBe("TASK-002");
    if (!secondTask) throw new Error("Watcher did not return the new task.");
    await runner.run({ command: "fake-llm", args: [secondTask.id] });
    await source.checkTask(prdPath, secondTask);
    expect(runner.requests).toHaveLength(2);
    expect(await source.getFirstUncheckedTask(prdPath)).toBeNull();
  });
});
