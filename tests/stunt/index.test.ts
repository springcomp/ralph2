import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStunt } from "../../src/stunt/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runStunt", () => {
  it("checks the first unchecked task when --check is passed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-stunt-"));
    temporaryDirectories.push(workspace);
    const queuePath = join(workspace, "queue.md");
    await writeFile(queuePath, "# Queue\n\n- [ ] TASK-001 - Do it\n", "utf8");

    const code = await runStunt(["--queue", queuePath, "--check"]);

    expect(code).toBe(0);
    expect(await readFile(queuePath, "utf8")).toContain("- [x] TASK-001");
  });

  it("leaves the task unchecked without --check", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-stunt-"));
    temporaryDirectories.push(workspace);
    const queuePath = join(workspace, "queue.md");
    await writeFile(queuePath, "# Queue\n\n- [ ] TASK-001 - Do it\n", "utf8");

    const code = await runStunt(["--queue", queuePath]);

    expect(code).toBe(0);
    expect(await readFile(queuePath, "utf8")).toContain("- [ ] TASK-001");
  });

  it("returns 0 without throwing when there is no unchecked task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-stunt-"));
    temporaryDirectories.push(workspace);
    const queuePath = join(workspace, "queue.md");
    await writeFile(queuePath, "# Queue\n\n- [x] TASK-001 - Done\n", "utf8");

    const code = await runStunt(["--queue", queuePath, "--check"]);

    expect(code).toBe(0);
  });

  it("throws when --queue is missing", async () => {
    await expect(runStunt([])).rejects.toThrow("--queue");
  });
});
