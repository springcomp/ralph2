import type { ProducerRegistration } from "../registry.js";

export const goalProducerRegistration: ProducerRegistration = {
  name: "goalProducer",
  create() {
    return {
      executable: "sh",
      arguments: ["-c", "test ! -e .agentic/__remaining_failures.log"],
      timeout: "15m",
      successExitCodes: [0],
    };
  },
};
