import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileCore, compileWorkflow } from "../../src/config/compiler.js";
import { parseWorkflowYaml } from "../../src/config/validator.js";
import { CoreEngine } from "../../src/core/engine-core.js";
import { WorkflowExitCodes } from "../../src/core/exit-codes.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/core/process-runner.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";
import { runStunt } from "../../src/stunt/index.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Delegates to the real stunt module in-process instead of spawning `node`.
const stuntRunner: ProcessRunner = {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const exitCode = await runStunt((request.args ?? []).slice(1));
    return { exitCode, signal: null, timedOut: false, cancelled: false };
  },
};

async function runSample(name: string) {
  const workspace = await mkdtemp(join(tmpdir(), `ralph-${name}-`));
  temporaryDirectories.push(workspace);
  await cp(join("samples", "blueprints", name), workspace, { recursive: true });

  const document = parseWorkflowYaml(
    await readFile(join(workspace, "ralph.yaml"), "utf8"),
  );
  const preliminary = compileWorkflow(
    document,
    workspace,
    {},
    defaultExtensionRegistry,
  );
  const source = new MarkdownTaskSource(
    preliminary.tasks.queue ?? preliminary.tasks.prd,
  );
  const core = compileCore(
    document,
    workspace,
    source,
    {},
    defaultExtensionRegistry,
  );
  const result = await new CoreEngine(stuntRunner, source).run(core);
  return { workspace, result };
}

describe("blueprint completion combinations", () => {
  it("agent-owned-finite: harness checks tasks itself, exits complete once BLUEPRINT.md drains", async () => {
    const { workspace, result } = await runSample("agent-owned-finite");

    expect(result.exitCode).toBe(WorkflowExitCodes.Complete);
    expect(await readFile(join(workspace, "BLUEPRINT.md"), "utf8")).toContain(
      "- [x] TASK-002",
    );
    expect(await readFile(join(workspace, "queue.md"), "utf8")).toContain(
      "- [x] TASK-002",
    );
  });

  it("engine-owned-finite: harness leaves the task unchecked, the engine checks it, exits complete", async () => {
    const { workspace, result } = await runSample("engine-owned-finite");

    expect(result.exitCode).toBe(WorkflowExitCodes.Complete);
    expect(await readFile(join(workspace, "queue.md"), "utf8")).toContain(
      "- [x] TASK-002",
    );
  });

  it("agent-owned-cron: exits blocked (not complete) once the single task drains the blueprint", async () => {
    const { workspace, result } = await runSample("agent-owned-cron");

    expect(result.exitCode).toBe(WorkflowExitCodes.Blocked);
    expect(await readFile(join(workspace, "BLUEPRINT.md"), "utf8")).toContain(
      "- [x] TASK-001",
    );
  });
});
