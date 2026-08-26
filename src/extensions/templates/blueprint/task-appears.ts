import type { TriggerRegistration } from "../../registry.js";

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Polls the observed Markdown source until it contains an unchecked task, then
 * fires. Reuses the existing checkbox as an idempotency cursor: a task the
 * runner has already drained is checked (`- [x]`), so only genuinely new,
 * unchecked work wakes the loop.
 */
export const taskAppearsTrigger: TriggerRegistration = {
  name: "taskAppears",
  description:
    "Idle until an unchecked task appears in the observed Markdown source, then resume the workflow.",
  properties: [
    {
      name: "source",
      type: "string",
      required: false,
      description:
        "Path to the observed Markdown file. Defaults to the PRD task file.",
    },
    {
      name: "pollInterval",
      type: "string",
      required: false,
      description: "Poll cadence (e.g. `5s`, `2m`). Defaults to 5 seconds.",
    },
  ],
  callback: async ({ pollIntervalMs, observedSource, signal }) => {
    while (!signal?.aborted) {
      let task = null;
      try {
        task = await observedSource.getFirstUncheckedTask();
      } catch {
        task = null;
      }
      if (task) return { reason: `Unchecked task ${task.id} appeared.` };
      await delay(pollIntervalMs, signal);
    }
    return null;
  },
};
