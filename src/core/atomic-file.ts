import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const renameRetryDelaysMs = [5, 10, 25, 50, 100];

async function replaceWithRetry(
  temporary: string,
  path: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = renameRetryDelaysMs[attempt];
      if (
        delay === undefined ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")
      ) {
        throw error;
      }
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, delay),
      );
    }
  }
}

/** Writes content via a temp file + rename so readers never see a partial write. */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await replaceWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
