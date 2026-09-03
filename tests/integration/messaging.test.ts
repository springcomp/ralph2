import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowPlan } from "../../src/config/compiler.js";
import { lowerWorkSource } from "../../src/config/lowering/worksource.js";
import { addTaskMessage } from "../../src/extensions/templates/blueprint/add-task-message.js";
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

describe("message send -> trigger receive integration", () => {
  it("delivers a message sent via addTask to a watcher idling on taskAppears", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-messaging-"));
    temporaryDirectories.push(workspace);
    const queuePath = join(workspace, "queue.md");
    const blueprintPath = join(workspace, "BLUEPRINT.md");
    await writeFile(queuePath, "# Task Queue\n\n", "utf8");
    await writeFile(blueprintPath, "# Blueprint\n\n", "utf8");

    const plan = {
      workspace,
      tasks: {
        queue: queuePath,
        prd: queuePath,
        progress: join(workspace, "progress.txt"),
        prompt: join(workspace, "prompt.md"),
      },
      continuation: {
        kind: "blueprint",
        source: blueprintPath,
        completeWhenSourceExhausted: true,
      },
      trigger: {
        kind: "taskAppears",
        source: blueprintPath,
        pollIntervalMs: 5,
      },
    } as WorkflowPlan;
    const source = new MarkdownTaskSource(queuePath);
    const workflow = lowerWorkSource(plan, source, defaultExtensionRegistry);

    // The watcher has no work yet; its taskAppears trigger idles.
    const waitingForMessage = workflow.pull(1);

    // A separate "sender" instance's onSuccess hook fires the addTask message,
    // appending directly to the watcher's observed BLUEPRINT.md.
    const sent: unknown[] = [];
    await addTaskMessage.callback({
      target: blueprintPath,
      task: "- [ ] MSG-001 - Heartbeat from sender",
      expand: (value) => value,
      iteration: 1,
      emit: async (event) => {
        sent.push(event);
      },
    });

    const delivered = await waitingForMessage;
    expect(delivered?.id).toBe("MSG-001");
    expect(sent).toEqual([
      {
        type: "message.sent",
        iteration: 1,
        message: `Task sent to ${blueprintPath}.`,
      },
    ]);
    expect(await readFile(blueprintPath, "utf8")).toContain(
      "- [x] MSG-001 - Heartbeat from sender",
    );
    expect(await source.getFirstUncheckedTask()).toMatchObject({
      id: "MSG-001",
    });
  });
});
