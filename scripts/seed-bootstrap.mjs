import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "bootstrap"), { recursive: true });
await cp(resolve(root, "dist"), resolve(root, "bootstrap"), {
  recursive: true,
});
