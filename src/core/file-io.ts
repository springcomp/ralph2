import { readFile } from "node:fs/promises";

/**
 * Read UTF-8 text while preserving errno code and adding the path to errors.
 * Raw fs errors only say `EISDIR`, which is not enough to diagnose a bad
 * workflow path from a pipeline log.
 */
export async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    const detail = code ? `${code}: ` : "";
    const wrapped = new Error(
      `Unable to read file '${path}': ${detail}${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ) as NodeJS.ErrnoException;
    if (code) wrapped.code = code;
    throw wrapped;
  }
}

export async function readTextFileIfPresent(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  }
}
