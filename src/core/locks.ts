import { access, mkdir, open, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { WorkflowExitCodes } from "./exit-codes.js";
import { readTextFile } from "./file-io.js";

export interface LockMetadata {
  readonly pid: number;
  readonly hostname: string;
  readonly timestamp: string;
}

export class LockError extends Error {
  readonly exitCode = WorkflowExitCodes.Blocked;

  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

const currentHost = hostname();

function metadata(): LockMetadata {
  return {
    pid: process.pid,
    hostname: currentHost,
    timestamp: new Date().toISOString(),
  };
}

async function readMetadata(path: string): Promise<LockMetadata | undefined> {
  try {
    const value: unknown = JSON.parse(await readTextFile(path));
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as LockMetadata).pid === "number" &&
      typeof (value as LockMetadata).hostname === "string" &&
      typeof (value as LockMetadata).timestamp === "string"
    ) {
      return value as LockMetadata;
    }
  } catch {
    // Lock may be partially written or removed by another process.
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeStale(
  path: string,
  staleAfterMs: number,
): Promise<boolean> {
  const details = await readMetadata(path);
  if (!details) {
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs <= staleAfterMs) return false;
      await rm(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  const active =
    details.hostname === currentHost && processIsAlive(details.pid);
  const age = Date.now() - Date.parse(details.timestamp);
  if (active || !Number.isFinite(age) || age <= staleAfterMs) return false;
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function writeExclusive(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(JSON.stringify(metadata(), null, 2));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

abstract class Lock {
  protected held = false;

  protected constructor(readonly path: string) {}

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await rm(this.path, { force: true });
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await action();
    } finally {
      await this.release();
    }
  }

  abstract acquire(): Promise<void>;
}

export interface WorkspaceLockOptions {
  readonly staleAfterMs?: number;
}

export class WorkspaceLock extends Lock {
  private readonly staleAfterMs: number;

  constructor(workspace: string, options: WorkspaceLockOptions = {}) {
    super(resolve(workspace, ".agentic", ".ralph.lock"));
    this.staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (await writeExclusive(this.path)) {
      this.held = true;
      return;
    }
    if (
      (await removeStale(this.path, this.staleAfterMs)) &&
      (await writeExclusive(this.path))
    ) {
      this.held = true;
      return;
    }
    const owner = await readMetadata(this.path);
    const suffix = owner ? ` (pid ${owner.pid} on ${owner.hostname})` : "";
    throw new LockError(`Workspace is locked${suffix}`);
  }
}

export interface StateLockOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly staleAfterMs?: number;
}

export class StateLock extends Lock {
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly staleAfterMs: number;

  constructor(filePath: string, options: StateLockOptions = {}) {
    super(`${resolve(filePath)}.ralph-state.lock`);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retryMs = options.retryMs ?? 25;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    do {
      if (await writeExclusive(this.path)) {
        this.held = true;
        return;
      }
      if (await removeStale(this.path, this.staleAfterMs)) continue;
      if (Date.now() >= deadline) break;
      await new Promise<void>((done) => setTimeout(done, this.retryMs));
    } while (Date.now() <= deadline);
    throw new LockError(`State lock acquisition timed out: ${this.path}`);
  }
}

export async function lockExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export { currentHost };
