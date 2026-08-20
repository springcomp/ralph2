import { access } from "node:fs/promises";
import type { PredicateRegistration } from "../registry.js";

export const fileExistsPredicate: PredicateRegistration = {
  name: "fileExists",
  description: "Complete when the configured file exists.",
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
      return true;
    } catch {
      return false;
    }
  },
};
