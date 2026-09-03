import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTaskMessage } from "../../src/extensions/templates/blueprint/add-task.js";
import { MarkdownTaskError } from "../../src/task-source/markdown-task-source.js";

describe("addTaskMessage", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ralph-add-task-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("appends a checkable task to a target file that does not yet exist", async () => {
    const target = join(workspace, "BLUEPRINT.md");
    const events: unknown[] = [];
    await addTaskMessage.callback({
      target,
      task: "- [ ] MSG-001 - Heartbeat",
      expand: (value) => value,
      iteration: 3,
      emit: async (event) => {
        events.push(event);
      },
    });
    expect(await readFile(target, "utf8")).toBe("- [ ] MSG-001 - Heartbeat");
    expect(events).toEqual([
      {
        type: "message.sent",
        iteration: 3,
        message: `Task sent to ${target}.`,
      },
    ]);
  });

  it("inserts a second message ahead of an earlier still-unchecked one", async () => {
    const target = join(workspace, "BLUEPRINT.md");
    await addTaskMessage.callback({
      target,
      task: "- [ ] MSG-001 - First",
      expand: (value) => value,
      iteration: 1,
      emit: async () => undefined,
    });
    await addTaskMessage.callback({
      target,
      task: "- [ ] MSG-002 - Second",
      expand: (value) => value,
      iteration: 2,
      emit: async () => undefined,
    });
    // scheduleTask() inserts new unchecked tasks ahead of the first unchecked line.
    expect(await readFile(target, "utf8")).toBe(
      "- [ ] MSG-002 - Second\n- [ ] MSG-001 - First",
    );
  });

  it("expands target and task through the provided expander", async () => {
    const target = join(workspace, "{NAME}.md");
    const resolved = join(workspace, "BLUEPRINT.md");
    await addTaskMessage.callback({
      target,
      task: "- [ ] MSG-{N} - Hi",
      expand: (value) => value.replace("{NAME}", "BLUEPRINT").replace("{N}", "001"),
      iteration: 1,
      emit: async () => undefined,
    });
    expect(await readFile(resolved, "utf8")).toBe("- [ ] MSG-001 - Hi");
  });

  it("rejects a task line that is not a valid unchecked Markdown task", async () => {
    const target = join(workspace, "BLUEPRINT.md");
    await expect(
      addTaskMessage.callback({
        target,
        task: "not a task line",
        expand: (value) => value,
        iteration: 1,
        emit: async () => undefined,
      }),
    ).rejects.toThrow(MarkdownTaskError);
  });
});
