import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compiler.js";
import { parseWorkflowYaml } from "../../src/config/validator.js";
import { WorkflowEngine } from "../../src/core/engine.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/core/process-runner.js";
import { defaultExtensionRegistry } from "../../src/extensions/registry.js";
import { MarkdownTaskSource } from "../../src/task-source/markdown-task-source.js";

const success = (): ProcessResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
});

class FakeCodingAgent implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly prdPath: string) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.command !== "pi")
      throw new Error(`Unexpected fake process: ${request.command}`);

    const prd = await readFile(this.prdPath, "utf8");
    if (!/- \[ \] /.test(prd))
      throw new Error("coding agent received no unchecked task");
    await writeFile(this.prdPath, prd.replace("- [ ]", "- [x]"), "utf8");
    return success();
  }
}

describe("blueprint template integration", () => {
  let workspace: string;
  let agentic: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ralph-blueprint-integration-"));
    agentic = join(workspace, ".agentic");
    await mkdir(agentic, { recursive: true });
    const template = defaultExtensionRegistry.template("blueprint");
    if (!template) throw new Error("Blueprint template is not registered");

    for (const [name, content] of template.files)
      await writeFile(join(agentic, name), content, "utf8");
    await writeFile(
      join(agentic, "BLUEPRINT.md"),
      "# Blueprint\n\n- [ ] TASK-001 - First task\n- [ ] TASK-002 - Second task\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("seeds and completes blueprint tasks until the source is exhausted", async () => {
    const configPath = join(agentic, "ralph.yaml");
    const plan = compileWorkflow(
      parseWorkflowYaml(await readFile(configPath, "utf8")),
      agentic,
    );
    const runner = new FakeCodingAgent(join(agentic, "PRD.md"));
    const result = await new WorkflowEngine(
      runner,
      new MarkdownTaskSource(),
    ).run(plan);

    expect(result.status).toBe("complete");
    expect(runner.requests).toHaveLength(2);
    expect(
      result.events.filter(({ type }) => type === "continuation.seeded"),
    ).toHaveLength(2);
    expect(
      (await readFile(join(agentic, "PRD.md"), "utf8")).match(/- \[x\]/g),
    ).toHaveLength(2);
    expect(
      (await readFile(join(agentic, "BLUEPRINT.md"), "utf8")).match(/- \[x\]/g),
    ).toHaveLength(2);
  });
});
