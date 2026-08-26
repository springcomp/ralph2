import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextFile, readTextFileIfPresent } from "../../src/core/file-io.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("file reads", () => {
  it("reports path when configured file is a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-file-io-"));
    directories.push(directory);
    const target = join(directory, "PRD.md");
    await mkdir(target);

    await expect(readTextFile(target)).rejects.toThrow(
      `Unable to read file '${target}': EISDIR:`,
    );
  });

  it("only ignores missing files for optional reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-file-io-"));
    directories.push(directory);

    await expect(
      readTextFileIfPresent(join(directory, "missing")),
    ).resolves.toBe("");
    await expect(readTextFileIfPresent(directory)).rejects.toThrow(
      `Unable to read file '${directory}': EISDIR:`,
    );
  });
});
