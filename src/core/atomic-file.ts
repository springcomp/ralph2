import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Writes content via a temp file + rename so readers never see a partial write. */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
