import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CircuitBreakerRegistration } from "../registry.js";

const run = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * jj auto-snapshots the working copy at the start of every `jj` invocation, so a
 * single `jj log` call for the current change (`@`) always reflects live,
 * uncommitted state. This is preferred over git plumbing for jj-managed
 * workspaces, including `jj git init --colocate` repositories, because jj's
 * working-copy state is not reliably reflected in git's HEAD/index without an
 * explicit export step.
 */
async function jjSignature(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      "jj",
      ["log", "--no-graph", "-T", "commit_id", "-r", "@"],
      { cwd: workspace },
    );
    const id = stdout.trim();
    return id ? `jj:${id}` : null;
  } catch {
    return null;
  }
}

async function gitSignature(workspace: string): Promise<string | null> {
  try {
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: workspace });
    const diff = await run("git", ["diff"], { cwd: workspace });
    const hash = createHash("sha256")
      .update(head.stdout)
      .update(diff.stdout)
      .digest("hex");
    return `git:${hash}`;
  } catch {
    return null;
  }
}

/**
 * Signature reflects whether the workspace's version-control state changed this
 * iteration. Prefers jj over raw git plumbing when a `.jj` directory is present;
 * falls back to git; otherwise inactive (returns null, never errors the run).
 * Unrecognized VCS or different progress semantics should register a custom
 * circuit breaker check with the same callback shape instead of extending this
 * built-in.
 */
export const noProgressCircuitBreaker: CircuitBreakerRegistration = {
  name: "noProgress",
  description:
    "Trips when the workspace's version-control state (jj or git) is unchanged across consecutive iterations.",
  properties: [],
  callback: async ({ workspace }) => {
    if (await exists(join(workspace, ".jj"))) return jjSignature(workspace);
    if (await exists(join(workspace, ".git"))) return gitSignature(workspace);
    return null;
  },
};
