import { MarkdownTaskSource } from "../../../task-source/markdown-task-source.js";
import type { MessageRegistration } from "../../registry.js";

export const addTaskMessage: MessageRegistration = {
  name: "addTask",
  description:
    "Append a checkable task to a configurable Markdown file, e.g. another Ralph instance's observed source.",
  properties: [
    {
      name: "target",
      type: "string",
      required: true,
      description: "Path to the Markdown file to append the task to.",
    },
    {
      name: "task",
      type: "string",
      required: true,
      description: "Markdown task text to insert into the target file.",
    },
  ],
  callback: async ({ target, task, expand, iteration, emit }) => {
    const path = expand(target);
    await new MarkdownTaskSource(path).scheduleTask(expand(task));
    await emit({
      type: "message.sent",
      iteration,
      message: `Task sent to ${path}.`,
    });
  },
};
