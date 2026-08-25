import { describe, expect, it } from "vitest";
import {
  type PlaceholderContext,
  PlaceholderExpander,
  PlaceholderRegistry,
  conditionalArguments,
} from "../../src/placeholders/placeholders.js";

const context: PlaceholderContext = {
  model: "model/x",
  agent: "coder",
  type: "TASK",
  number: "7",
  task: "Do work",
  taskLine: "- [ ] TASK-7 - Do work",
  prompt: "/tmp/prompt.md",
  prd: "/tmp/PRD.md",
  progress: "/tmp/progress.txt",
  iteration: 7,
  workspace: "/tmp/workspace",
};

describe("PlaceholderRegistry", () => {
  it("defines every supported placeholder", () => {
    expect(PlaceholderRegistry.definitions.map(({ name }) => name)).toEqual([
      "MODEL",
      "AGENT",
      "TYP",
      "NUM",
      "TASK",
      "TASK_LINE",
      "ROOT",
      "PROMPT",
      "PRD",
      "PROGRESS",
      "ITERATION",
      "ITERATION:000",
      "WORKSPACE",
    ]);
  });
});

describe("PlaceholderExpander", () => {
  const expander = new PlaceholderExpander();

  it("expands all values and repeated tokens", () => {
    expect(
      expander.expand(
        "{MODEL}|{AGENT}|{TYP}|{NUM}|{TASK}|{TASK_LINE}|{PROMPT}|{PRD}|{PROGRESS}|{ITERATION}|{ITERATION:000}|{WORKSPACE}|{NUM}",
        context,
      ),
    ).toBe(
      "model/x|coder|TASK|7|Do work|- [ ] TASK-7 - Do work|/tmp/prompt.md|/tmp/PRD.md|/tmp/progress.txt|7|007|/tmp/workspace|7",
    );
  });

  it("replaces missing optional values with empty string", () => {
    expect(
      expander.expand("<{MODEL}><{AGENT}><{TASK}>", { iteration: 1 }),
    ).toBe("<><><>");
  });

  it("supports zero padding beyond three digits", () => {
    expect(
      expander.expand("literal {ITERATION:000}", { iteration: 1234 }),
    ).toBe("literal 1234");
  });

  it("expands each argument without splitting it", () => {
    expect(
      expander.expandArguments(
        { arguments: ["--prompt", "hello {TASK}"] },
        context,
      ),
    ).toEqual(["--prompt", "hello Do work"]);
  });

  it("appends conditional groups only for nonblank values", () => {
    const groups = [
      { whenSet: "MODEL", arguments: ["--model", "{MODEL}"] },
      { whenSet: "AGENT", arguments: ["--agent", "{AGENT}"] },
    ];
    expect(
      expander.expandArguments(
        { arguments: ["run"], conditionalArguments: groups },
        { ...context, agent: " " },
      ),
    ).toEqual(["run", "--model", "model/x"]);
    expect(conditionalArguments(groups, context)).toEqual([
      "--model",
      "model/x",
      "--agent",
      "coder",
    ]);
  });

  it("expands environment records and output paths", () => {
    expect(
      expander.expandEnvironment(
        { MODE: "{MODEL}", ITER: "{ITERATION:000}" },
        context,
      ),
    ).toEqual({ MODE: "model/x", ITER: "007" });
    expect(expander.expandOutputPath("logs/{TYP}-{NUM}.log", context)).toBe(
      "logs/TASK-7.log",
    );
  });

  it("rejects unknown placeholders", () => {
    expect(() => expander.expand("{NOPE}", context)).toThrow(
      "Unknown placeholder: {NOPE}",
    );
    expect(() =>
      expander.expandArguments(
        { conditionalArguments: [{ whenSet: "ITERATION:000", arguments: [] }] },
        context,
      ),
    ).toThrow();
  });
});
