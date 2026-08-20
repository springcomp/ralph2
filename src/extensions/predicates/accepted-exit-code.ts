import type { PredicateRegistration } from "../registry.js";

export const acceptedExitCodePredicate: PredicateRegistration = {
  name: "acceptedExitCode",
  description: "Complete when the completion check exits successfully.",
  properties: [
    {
      name: "check",
      type: "command",
      required: true,
      description:
        "Command used to determine whether continuation is complete.",
    },
  ],
  callback: async ({ check, runStage }) => {
    if (!check) return false;
    return (await runStage(check)).success;
  },
};
