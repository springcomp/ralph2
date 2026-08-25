import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MarkdownTaskError,
  MarkdownTaskSource,
  parseTaskLine,
} from "../../src/task-source/markdown-task-source.js";

const roots: string[] = [];
async function files(prd = "# PRD\n- [ ] TASK-001 - First\n") {
  const root = await mkdtemp(join(tmpdir(), "ralph-markdown-"));
  roots.push(root);
  const prdPath = join(root, "PRD.md");
  await writeFile(prdPath, prd);
  return { root, prdPath };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parseTaskLine", () => {
  it("parses identity, description, raw line, and metadata", () => {
    const line = "  - [ ] FIX-007 - Repair build (model: `gpt`) (agent: `pi`)";
    expect(parseTaskLine(line)).toMatchObject({
      typ: "FIX",
      num: "007",
      id: "FIX-007",
      description: "Repair build",
      rawLine: line,
      model: "gpt",
      agent: "pi",
    });
  });
  it("accepts checked states and rejects malformed duplicate metadata", () => {
    expect(parseTaskLine("- [x] T-1 - Done")?.description).toBe("Done");
    expect(parseTaskLine("plain markdown")).toBeNull();
    expect(() =>
      parseTaskLine("- [ ] T-1 - X (model: `a`) (MODEL: `b`)"),
    ).toThrow(MarkdownTaskError);
  });
});

describe("MarkdownTaskSource", () => {
  it("gets first unchecked and ignores checked tasks", async () => {
    const { prdPath } = await files("- [x] T-1 - Done\n- [ ] T-2 - Next\n");
    expect(
      (await new MarkdownTaskSource().getFirstUncheckedTask(prdPath))?.id,
    ).toBe("T-2");
  });
  it("rejects duplicate unchecked identities", async () => {
    const { prdPath } = await files("- [ ] T-1 - One\n- [ ] T-1 - Two\n");
    await expect(
      new MarkdownTaskSource().getFirstUncheckedTask(prdPath),
    ).rejects.toThrow(/ambiguous/);
  });
  it("checks task while preserving surrounding markdown and CRLF", async () => {
    const { prdPath } = await files("# H\r\n  - [ ] T-1 - First\r\nend\r\n");
    const source = new MarkdownTaskSource();
    const task = await source.getFirstUncheckedTask(prdPath);
    expect(task).not.toBeNull();
    if (!task) throw new Error("Expected task");
    await source.checkTask(prdPath, task);
    expect(await readFile(prdPath, "utf8")).toBe(
      "# H\r\n  - [x] T-1 - First\r\nend\r\n",
    );
  });
  it("checks exact task state without being fooled by earlier remediation", async () => {
    const { prdPath } = await files(
      "- [ ] TASK-1 - First\n- [ ] TASK-2 - Second\n",
    );
    const source = new MarkdownTaskSource();
    const target = await source.getFirstUncheckedTask(prdPath);
    if (!target) throw new Error("Expected task");
    await source.scheduleTask(prdPath, "- [ ] FIX-1 - Repair");
    expect(await source.isTaskUnchecked(prdPath, target)).toBe(true);
    await source.checkTask(prdPath, target);
    expect(await source.isTaskUnchecked(prdPath, target)).toBe(false);
  });
  it("rejects missing or changed exact tasks", async () => {
    const { prdPath } = await files();
    const source = new MarkdownTaskSource();
    const target = await source.getFirstUncheckedTask(prdPath);
    if (!target) throw new Error("Expected task");
    await writeFile(prdPath, "- [ ] TASK-001 - Changed\n");
    await expect(source.isTaskUnchecked(prdPath, target)).rejects.toThrow(
      /no longer matches/,
    );
    await writeFile(prdPath, "- [ ] OTHER-1 - Other\n");
    await expect(source.isTaskUnchecked(prdPath, target)).rejects.toThrow(
      /no longer exists/,
    );
  });
  it("schedules before first unchecked and replaces same identity", async () => {
    const { prdPath } = await files(
      "- [x] T-1 - Done\n- [ ] FIX-2 - Old\n- [ ] T-3 - Later\n",
    );
    const source = new MarkdownTaskSource();
    await source.scheduleTask(prdPath, "- [ ] FIX-2 - New");
    expect(await readFile(prdPath, "utf8")).toBe(
      "- [x] T-1 - Done\n- [ ] FIX-2 - New\n- [ ] T-3 - Later\n",
    );
  });

  it("schedules at the end of file when no unchecked tasks exist and validates task line", async () => {
    const { prdPath } = await files("- [x] T-1 - Done");
    const source = new MarkdownTaskSource();
    await source.scheduleTask(prdPath, "- [ ] T-2 - New");
    expect(await readFile(prdPath, "utf8")).toBe(
      "- [x] T-1 - Done\n- [ ] T-2 - New",
    );

    await expect(source.scheduleTask(prdPath, "invalid task")).rejects.toThrow(
      MarkdownTaskError,
    );
    await expect(
      source.scheduleTask(prdPath, "- [x] T-3 - Already checked"),
    ).rejects.toThrow(MarkdownTaskError);
  });
  it("seeds first blueprint task, checks source, and handles missing/exhausted source", async () => {
    const { root, prdPath } = await files("# PRD\n");
    const blueprint = join(root, "BLUEPRINT.md");
    await writeFile(blueprint, "Intro\n- [ ] T-9 - Seed\n- [ ] T-10 - Later\n");
    const source = new MarkdownTaskSource();
    expect(
      await source.seedBlueprintTask(prdPath, join(root, "missing.md")),
    ).toBeNull();
    expect(await source.seedBlueprintTask(prdPath, blueprint)).toBe(
      "- [ ] T-9 - Seed",
    );
    expect(await readFile(blueprint, "utf8")).toContain("- [x] T-9 - Seed");
    expect(await readFile(prdPath, "utf8")).toContain("- [ ] T-9 - Seed");
  });
});
