import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowExitCodes } from "./exit-codes.js";
import {
  LockError,
  StateLock,
  WorkspaceLock,
  currentHost,
  lockExists,
} from "./locks.js";

const workspaces: string[] = [];
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ralph-locks-"));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkspaceLock", () => {
  it("creates metadata lock and releases it", async () => {
    const root = await workspace();
    const lock = new WorkspaceLock(root);
    await lock.acquire();
    const path = join(root, ".agentic", ".ralph.lock");
    expect(await lockExists(path)).toBe(true);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    expect(metadata).toMatchObject({ pid: process.pid, hostname: currentHost });
    expect(Date.parse(metadata.timestamp)).not.toBeNaN();
    await lock.release();
    expect(await lockExists(path)).toBe(false);
    await lock.release();
  });

  it("blocks active lock owner with exit code 3", async () => {
    const root = await workspace();
    const first = new WorkspaceLock(root);
    const second = new WorkspaceLock(root);
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({
      exitCode: WorkflowExitCodes.Blocked,
    });
    await expect(second.withLock(async () => "no")).rejects.toBeInstanceOf(
      LockError,
    );
    await first.release();
  });

  it("recovers stale lock", async () => {
    const root = await workspace();
    const path = join(root, ".agentic", ".ralph.lock");
    await mkdir(join(root, ".agentic"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid: 99999999,
        hostname: currentHost,
        timestamp: new Date(0).toISOString(),
      }),
    );
    const lock = new WorkspaceLock(root, { staleAfterMs: 1 });
    await lock.acquire();
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("does not remove recent malformed lock and recovers old malformed lock", async () => {
    const root = await workspace();
    const path = join(root, ".agentic", ".ralph.lock");
    await mkdir(join(root, ".agentic"), { recursive: true });
    await writeFile(path, "partial");
    await expect(
      new WorkspaceLock(root, { staleAfterMs: 60_000 }).acquire(),
    ).rejects.toBeInstanceOf(LockError);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    const lock = new WorkspaceLock(root, { staleAfterMs: 1 });
    await lock.acquire();
    await lock.release();
  });
});

describe("StateLock", () => {
  it("uses adjacent state lock and releases through withLock", async () => {
    const root = await workspace();
    const file = join(root, "PRD.md");
    const lock = new StateLock(file);
    await lock.withLock(async () =>
      expect(await lockExists(lock.path)).toBe(true),
    );
    expect(await lockExists(lock.path)).toBe(false);
  });

  it("waits for contention then acquires after release", async () => {
    const root = await workspace();
    const first = new StateLock(join(root, "PRD.md"));
    const second = new StateLock(join(root, "PRD.md"), {
      timeoutMs: 200,
      retryMs: 5,
    });
    await first.acquire();
    const pending = second.acquire();
    setTimeout(() => void first.release(), 25);
    await pending;
    await second.release();
  });

  it("times out with blocked exit code", async () => {
    const root = await workspace();
    const first = new StateLock(join(root, "PRD.md"));
    const second = new StateLock(join(root, "PRD.md"), {
      timeoutMs: 10,
      retryMs: 1,
    });
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({
      exitCode: WorkflowExitCodes.Blocked,
      message: expect.stringContaining("timed out"),
    });
    await first.release();
  });

  it("recovers stale state lock", async () => {
    const root = await workspace();
    const file = join(root, "PRD.md");
    const path = `${file}.ralph-state.lock`;
    await writeFile(
      path,
      JSON.stringify({
        pid: 99999999,
        hostname: currentHost,
        timestamp: new Date(0).toISOString(),
      }),
    );
    const lock = new StateLock(file, { staleAfterMs: 1, timeoutMs: 20 });
    await lock.acquire();
    await lock.release();
  });
});
