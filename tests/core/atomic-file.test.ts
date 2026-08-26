import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  renameMock: vi.fn(),
  realRename: undefined as typeof import("node:fs/promises").rename | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsState.realRename = actual.rename;
  return { ...actual, rename: fsState.renameMock };
});

import { atomicWrite } from "../../src/core/atomic-file.js";

const roots: string[] = [];

afterEach(async () => {
  fsState.renameMock.mockReset();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("atomicWrite", () => {
  it("writes content through a temporary file and replaces the target", async () => {
    fsState.renameMock.mockImplementation(
      async (temporary: string, target: string) => {
        await fsState.realRename?.(temporary, target);
      },
    );
    const root = await mkdtemp(join(tmpdir(), "ralph-atomic-"));
    roots.push(root);
    const path = join(root, "nested", "state.json");

    await atomicWrite(path, "content");

    expect(await readFile(path, "utf8")).toBe("content");
    expect(fsState.renameMock).toHaveBeenCalledOnce();
  });

  it.each(["EPERM", "EACCES", "EBUSY"] as const)(
    "retries transient %s rename failures",
    async (code) => {
      fsState.renameMock
        .mockRejectedValueOnce(Object.assign(new Error(code), { code }))
        .mockImplementation(async (temporary: string, target: string) => {
          await fsState.realRename?.(temporary, target);
        });
      const root = await mkdtemp(join(tmpdir(), "ralph-atomic-"));
      roots.push(root);

      await atomicWrite(join(root, "state.json"), "content");

      expect(fsState.renameMock).toHaveBeenCalledTimes(2);
    },
  );

  it("propagates non-transient rename failures", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    fsState.renameMock.mockRejectedValue(error);
    const root = await mkdtemp(join(tmpdir(), "ralph-atomic-"));
    roots.push(root);

    await expect(atomicWrite(join(root, "state.json"), "content")).rejects.toBe(
      error,
    );
  });

  it("stops retrying after the transient rename retry budget", async () => {
    const error = Object.assign(new Error("busy"), { code: "EBUSY" });
    fsState.renameMock.mockRejectedValue(error);
    const root = await mkdtemp(join(tmpdir(), "ralph-atomic-"));
    roots.push(root);

    await expect(atomicWrite(join(root, "state.json"), "content")).rejects.toBe(
      error,
    );
    expect(fsState.renameMock).toHaveBeenCalledTimes(6);
  });
});
