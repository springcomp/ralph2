import type { ActionRegistration } from "../../registry.js";

export const scheduleTaskAction: ActionRegistration = {
  name: "scheduleTask",
  description: "Schedule a task in the PRD when a stage fails.",
  properties: [
    {
      name: "task",
      type: "string",
      required: true,
      description: "Markdown task text to insert into the PRD.",
    },
  ],
  callback: async ({ source, stage, expand, iteration, emit }) => {
    await source.scheduleTask(expand(stage.failureTask ?? ""));
    await emit({
      type: "fix.scheduled",
      iteration,
      stage: stage.name,
      message: "Failure task scheduled.",
    });
  },
};
