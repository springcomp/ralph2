import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProcessRunner } from "../../src/core/fake-process-runner.js";
import {
  type ProcessResult,
  RealProcessRunner,
  redactSecrets,
} from "../../src/core/process-runner.js";

const runner = new RealProcessRunner();
const tempDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ralph-runner-"));
  tempDirectories.push(directory);
  return directory;
}

function nodeScript(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", source] };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("redactSecrets", () => {
  it("replaces secrets and ignores empty values", () => {
    expect(
      redactSecrets("a token and longer-secret", [
        "",
        "token",
        "longer-secret",
      ]),
    ).toBe("a [REDACTED] and [REDACTED]");
  });
});

describe("RealProcessRunner", () => {
  it("runs with arguments and environment, streams output, and writes a log", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "nested", "run.log");
    const output: string[] = [];
    const script = nodeScript(
      "process.stdout.write(process.env.RALPH_VALUE + ':' + process.argv[1]); process.stderr.write(':err')",
    );

    const result = await runner.run({
      ...script,
      args: [...script.args, "arg value"],
      env: { RALPH_VALUE: "value" },
      outputPath,
      onOutput: (text, stream) => output.push(`${stream}:${text}`),
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    expect(output.join("")).toContain("stdout:value:arg value");
    expect(output.join("")).toContain("stderr::err");
    expect(await readFile(outputPath, "utf8")).toContain("value:arg value:err");
  });

  it("redacts configured secret values, including values split across chunks", async () => {
    const output: string[] = [];
    const script = nodeScript(
      "process.stdout.write('prefix-'); setTimeout(() => process.stdout.write(process.env.RALPH_SECRET + '-suffix'), 5)",
    );
    const result = await runner.run({
      ...script,
      env: { RALPH_SECRET: { value: "hidden", secret: true } },
      onOutput: (text) => output.push(text),
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("")).toBe("prefix-[REDACTED]-suffix");
  });

  it("reports nonzero exits and signals", async () => {
    const script = nodeScript("process.exit(7)");
    await expect(runner.run(script)).resolves.toMatchObject({ exitCode: 7 });
  });

  it("reports timeout and cancellation", async () => {
    const script = nodeScript("setInterval(() => {}, 1000)");
    await expect(
      runner.run({ ...script, timeoutMs: 10 }),
    ).resolves.toMatchObject({
      timedOut: true,
      cancelled: false,
    });

    const controller = new AbortController();
    const cancelled = runner.run({ ...script, signal: controller.signal });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      timedOut: false,
      cancelled: true,
    });
  });

  it("handles an already-aborted signal and spawn errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const script = nodeScript("setInterval(() => {}, 1000)");
    await expect(
      runner.run({ ...script, signal: controller.signal }),
    ).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(
      runner.run({ command: "ralph-command-that-does-not-exist" }),
    ).rejects.toThrow();
  });
});

describe("FakeProcessRunner", () => {
  it("records requests and returns queued or default results", async () => {
    const queued: ProcessResult = {
      exitCode: 4,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    const fake = new FakeProcessRunner([queued]);
    const request = { command: "test", args: ["arg"] };
    await expect(fake.run(request)).resolves.toBe(queued);
    await expect(fake.run({ command: "default" })).resolves.toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    fake.enqueue(queued);
    expect(fake.requests).toEqual([request, { command: "default" }]);
  });
});
