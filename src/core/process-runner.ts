import { type ChildProcess, spawn } from "node:child_process";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";
import type { IPty } from "@lydell/node-pty";

export interface SecretEnvironmentValue {
  readonly value: string;
  readonly secret: boolean;
}

export type ProcessEnvironment = Record<
  string,
  string | SecretEnvironmentValue
>;

export interface ProcessRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: ProcessEnvironment;
  readonly outputPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  /** undefined = auto-detect from Ralph's own stdout TTY-ness */
  readonly usePty?: boolean;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

class Redactor {
  private pending = "";
  private readonly secrets: readonly string[];

  constructor(secrets: readonly string[]) {
    this.secrets = secrets
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  push(text: string): string {
    const input = this.pending + text;
    const keep = Math.max(
      0,
      ...this.secrets.map((secret) => secret.length - 1),
    );
    const end = Math.max(0, input.length - keep);
    this.pending = input.slice(end);
    return redact(input.slice(0, end), this.secrets);
  }

  flush(): string {
    const result = redact(this.pending, this.secrets);
    this.pending = "";
    return result;
  }
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv;
  secrets: string[];
}

function resolveEnvironment(request: ProcessRequest): ResolvedEnvironment {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const secrets: string[] = [];
  for (const [key, configured] of Object.entries(request.env ?? {})) {
    const value =
      typeof configured === "string" ? configured : configured.value;
    env[key] = value;
    if (typeof configured !== "string" && configured.secret)
      secrets.push(value);
  }
  return { env, secrets };
}

function signalNameFromNumber(
  signal: number | undefined,
): NodeJS.Signals | null {
  if (!signal) return null;
  const entry = Object.entries(osConstants.signals).find(
    ([, value]) => value === signal,
  );
  return (entry?.[0] as NodeJS.Signals | undefined) ?? null;
}

const ptyStopSettleGraceMs = 250;

function terminatePty(child: IPty): void {
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // already exited
    }
    if (child.pid > 0) {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.on("error", () => {
        // ignore best-effort cleanup failures
      });
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already exited
  }
}

export class RealProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.outputPath)
      await mkdir(dirname(request.outputPath), { recursive: true });
    const log = request.outputPath
      ? await open(request.outputPath, "w")
      : undefined;

    const usePty = request.usePty ?? process.stdout.isTTY === true;
    if (usePty) {
      const result = await this.runWithPty(request, log);
      if (result) return result;
    }
    return await this.runWithPipes(request, log);
  }

  // Merges stdout/stderr into one stream (as a real terminal would); reports as "stdout".
  private async runWithPty(
    request: ProcessRequest,
    log: FileHandle | undefined,
  ): Promise<ProcessResult | undefined> {
    let pty: typeof import("@lydell/node-pty");
    try {
      pty = await import("@lydell/node-pty");
    } catch {
      return undefined;
    }

    const { env, secrets } = resolveEnvironment(request);
    // Tell color-detecting CLIs what kind of terminal they are attached to.
    env.TERM ??= "xterm-256color";
    env.COLORTERM ??= "truecolor";
    if (env.NO_COLOR === undefined) env.FORCE_COLOR ??= "1";
    let child: IPty;
    try {
      child = pty.spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env,
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        name: "xterm-256color",
      });
    } catch {
      // Unsupported platform/arch prebuild or allocation failure: fall back to pipes.
      return undefined;
    }

    const redactor = new Redactor(secrets);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stopFinalizeTimer: NodeJS.Timeout | undefined;

    return await new Promise<ProcessResult>((resolve) => {
      const finalize = async (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
        request.signal?.removeEventListener("abort", abort);
        dataSubscription.dispose();
        exitSubscription.dispose();
        const tail = redactor.flush();
        if (tail) {
          request.onOutput?.(tail, "stdout");
          await log?.write(tail);
          process.stdout.write(tail);
        }
        await log?.close();
        resolve({
          exitCode,
          signal,
          timedOut,
          cancelled,
        });
      };

      const stop = (reason: "timeout" | "cancel") => {
        if (settled) return;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;
        terminatePty(child);
        if (process.platform === "win32" && !stopFinalizeTimer) {
          stopFinalizeTimer = setTimeout(() => {
            void finalize(null, null);
          }, ptyStopSettleGraceMs);
        }
      };
      const abort = () => stop("cancel");

      const dataSubscription = child.onData((chunk) => {
        const text = redactor.push(chunk);
        if (text) {
          request.onOutput?.(text, "stdout");
          void log?.write(text);
          process.stdout.write(text);
        }
      });
      const exitSubscription = child.onExit(({ exitCode, signal }) => {
        void finalize(exitCode, signalNameFromNumber(signal));
      });

      if (request.signal) {
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }
      if (request.timeoutMs !== undefined && request.timeoutMs >= 0) {
        timer = setTimeout(() => stop("timeout"), request.timeoutMs);
      }
    });
  }

  private async runWithPipes(
    request: ProcessRequest,
    log: FileHandle | undefined,
  ): Promise<ProcessResult> {
    const { env, secrets } = resolveEnvironment(request);
    const redactor = new Redactor(secrets);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stopFinalizeTimer: NodeJS.Timeout | undefined;

    return await new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(request.command, [...(request.args ?? [])], {
          cwd: request.cwd,
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        void log?.close();
        reject(error);
        return;
      }

      const finalize = async (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
        request.signal?.removeEventListener("abort", abort);
        const tail = redactor.flush();
        if (tail) {
          request.onOutput?.(tail, "stdout");
          await log?.write(tail);
          process.stdout.write(tail);
        }
        await log?.close();
        resolve({ exitCode, signal, timedOut, cancelled });
      };
      const stop = (reason: "timeout" | "cancel") => {
        if (settled) return;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;
        killTree(child);
        if (process.platform === "win32" && !stopFinalizeTimer) {
          stopFinalizeTimer = setTimeout(() => {
            void finalize(null, null);
          }, ptyStopSettleGraceMs);
        }
      };
      const abort = () => stop("cancel");
      if (request.signal) {
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }
      if (request.timeoutMs !== undefined && request.timeoutMs >= 0) {
        timer = setTimeout(() => stop("timeout"), request.timeoutMs);
      }

      const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const text = redactor.push(chunk.toString("utf8"));
        if (text) {
          request.onOutput?.(text, stream);
          void log?.write(text);
          process.stdout.write(text);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => consume("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => consume("stderr", chunk));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
          request.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      child.on("close", async (exitCode, signal) => {
        await finalize(exitCode, signal);
      });
    });
  }
}

export const redactSecrets = (
  text: string,
  secrets: readonly string[],
): string => redact(text, secrets);
