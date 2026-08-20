import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

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

export class RealProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const secrets: string[] = [];
    for (const [key, configured] of Object.entries(request.env ?? {})) {
      const value =
        typeof configured === "string" ? configured : configured.value;
      env[key] = value;
      if (typeof configured !== "string" && configured.secret)
        secrets.push(value);
    }

    if (request.outputPath)
      await mkdir(dirname(request.outputPath), { recursive: true });
    const log = request.outputPath
      ? await open(request.outputPath, "w")
      : undefined;
    const redactor = new Redactor(secrets);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

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

      const stop = (reason: "timeout" | "cancel") => {
        if (settled) return;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;
        killTree(child);
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
          request.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      child.on("close", async (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        const tail = redactor.flush();
        if (tail) {
          request.onOutput?.(tail, "stdout");
          await log?.write(tail);
          process.stdout.write(tail);
        }
        await log?.close();
        resolve({ exitCode, signal, timedOut, cancelled });
      });
    });
  }
}

export const redactSecrets = (
  text: string,
  secrets: readonly string[],
): string => redact(text, secrets);
