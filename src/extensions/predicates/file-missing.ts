import { access } from "node:fs/promises";
import type { PredicateRegistration } from "../registry.js";

export const fileMissingPredicate: PredicateRegistration = {
  name: "fileMissing",
  description: "Complete when the configured file is missing.",
  properties: [
    {
      name: "path",
      type: "string",
      required: true,
      description: "Path to the file, relative to the workspace or absolute.",
    },
  ],
  callback: async ({ path, expand }) => {
    try {
      await access(expand(path ?? ""));
      return false;
    } catch {
      return true;
    }
  },
};
