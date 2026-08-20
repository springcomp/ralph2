import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const bootstrap = resolve(root, "bootstrap");

await rm(bootstrap, { recursive: true, force: true });
await mkdir(bootstrap, { recursive: true });
await cp(dist, bootstrap, { recursive: true });

for (const directory of ["cli", "config", "core", "templates"]) {
  await rm(resolve(bootstrap, directory), {
    recursive: true,
    force: false,
  }).catch(() => undefined);
  await mkdir(resolve(bootstrap, directory), { recursive: true });
}

// Re-stage runtime JavaScript and declarations, excluding Vitest suites.
for (const directory of ["cli", "config", "core", "templates"]) {
  await cp(resolve(dist, directory), resolve(bootstrap, directory), {
    recursive: true,
    filter: (source) => !source.includes(".test."),
  });
}

const entry = `#!/usr/bin/env node
import { createProgram } from "./cli/index.js";

await createProgram().parseAsync();
`;
await writeFile(resolve(bootstrap, "ralph.js"), entry, { mode: 0o755 });
console.log("Bootstrap bundle seeded at bootstrap/ralph.js");
