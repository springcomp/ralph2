import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noProgressCircuitBreaker } from "../../src/extensions/circuit-breakers/no-progress.js";
import { repeatedFailureSignatureCircuitBreaker } from "../../src/extensions/circuit-breakers/repeated-failure-signature.js";
import type { CircuitBreakerContext } from "../../src/extensions/types.js";

const run = promisify(execFile);

const context = (
  overrides: Partial<CircuitBreakerContext> = {},
): CircuitBreakerContext => ({
  kind: "noProgress",
  workspace: overrides.workspace ?? "/workspace",
  iteration: 1,
  expand: (value: string) => value,
  ...overrides,
});

describe("noProgressCircuitBreaker", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ralph-noprogress-"));
  });

  afterEach(async () => {
    // Git leaves file handles briefly held on Windows; retry the cleanup.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(workspace, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  it("returns null when the workspace uses no supported VCS", async () => {
    const signature = await noProgressCircuitBreaker.callback(
      context({ workspace }),
    );
    expect(signature).toBeNull();
  });

  it(
    "produces a stable git signature and detects changes",
    { timeout: 30_000 },
    async () => {
      await run("git", ["init"], { cwd: workspace });
      await run("git", ["config", "user.email", "t@t.com"], { cwd: workspace });
      await run("git", ["config", "user.name", "tester"], { cwd: workspace });
      await writeFile(join(workspace, "file.txt"), "hello");
      await run("git", ["add", "."], { cwd: workspace });
      await run("git", ["commit", "-m", "init"], { cwd: workspace });

      const first = await noProgressCircuitBreaker.callback(
        context({ workspace }),
      );
      expect(first).toMatch(/^git:/);

      const again = await noProgressCircuitBreaker.callback(
        context({ workspace }),
      );
      expect(again).toBe(first);

      await writeFile(join(workspace, "file.txt"), "changed");
      const changed = await noProgressCircuitBreaker.callback(
        context({ workspace }),
      );
      expect(changed).toMatch(/^git:/);
      expect(changed).not.toBe(first);
    },
  );

  it(
    "produces a jj signature when a jj repo is present",
    { timeout: 30_000 },
    async () => {
      try {
        await run("jj", ["git", "init"], { cwd: workspace });
      } catch {
        return; // jj not installed in this environment; skip.
      }
      const signature = await noProgressCircuitBreaker.callback(
        context({ workspace }),
      );
      expect(signature).toMatch(/^jj:/);
    },
  );

  it("returns null for a broken git directory without erroring", async () => {
    // A .git marker with no valid repo forces the git branch and its catch.
    await writeFile(join(workspace, ".git"), "not a repo");
    const signature = await noProgressCircuitBreaker.callback(
      context({ workspace }),
    );
    expect(signature).toBeNull();
  });
});

describe("repeatedFailureSignatureCircuitBreaker", () => {
  it("returns null when no stage failed this iteration", async () => {
    const signature = await repeatedFailureSignatureCircuitBreaker.callback(
      context({ kind: "repeatedFailureSignature" }),
    );
    expect(signature).toBeNull();
  });

  it("encodes stage and exit code when a stage failed", async () => {
    const signature = await repeatedFailureSignatureCircuitBreaker.callback(
      context({
        kind: "repeatedFailureSignature",
        lastFailure: { stage: "verify", exitCode: 2 },
      }),
    );
    expect(signature).toBe("verify:2");
  });

  it("renders a null exit code as the literal 'null'", async () => {
    const signature = await repeatedFailureSignatureCircuitBreaker.callback(
      context({
        kind: "repeatedFailureSignature",
        lastFailure: { stage: "verify", exitCode: null },
      }),
    );
    expect(signature).toBe("verify:null");
  });
});
