import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "text"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "tests/**/*.ts",
        "src/config/schema-v1.ts",
        "src/core/fake-process-runner.ts",
      ],
    },
  },
});
