import {
  BlueprintRefill,
  ChainedWorkSource,
} from "../../../config/lowering/worksource.js";
import type { TemplateRegistration } from "../../registry.js";
import type { ContinuationLowering } from "../../types.js";
import { goalTemplateRegistration } from "../goal.js";
import { taskAppearsTrigger } from "./task-appears.js";

const blueprintYaml = `schemaVersion: 1

workspace: ..
maxIterations: 100

tasks:
  format: markdown
  queue: .agentic/queue.md
  progress: .agentic/progress.txt
  prompt: .agentic/ralph.prompt.md
  metadata:
    model: model
    agent: agent

defaults:
  harness: pi
  model: null
  agent: null

harnesses:
  pi:
    executable: pi
    arguments:
      - --model
      - "{MODEL}"
      - --print
      - "Follow instructions from {PROMPT} queue={QUEUE} progress={PROGRESS}"
    conditionalArguments:
      - whenSet: AGENT
        arguments:
          - --agent
          - "{AGENT}"
    timeout: 30m
    successExitCodes: [0]
    output:
      combined: .agentic/__agent.log

preAgent: []
postAgent: []

verification:
  requireTaskChecked: true
  retries: 1
  prompt: |
    Task: {TASK}

    Verify work complete. Check task in the queue if complete, or document blockers in progress.txt.

continuation:
  kind: blueprint
  source: .agentic/BLUEPRINT.md
  completeWhenSourceExhausted: true

trigger:
  kind: taskAppears
  source: .agentic/BLUEPRINT.md
  pollInterval: 60s
`;

const files = new Map(goalTemplateRegistration.files);
files.set("ralph.yaml", blueprintYaml);
files.set("GOAL.md", "# Goal\n\n");
files.set("queue.md", "# Ralph execution queue\n\n");
files.set(
  "ralph.prompt.md",
  `
---
argument-hint: [queue={QUEUE}] [progress={PROGRESS}]
---
# Ralph Loop

You are a coding agent running in a loop at workspace root.
Each iteration, you get a fresh context window.

## Files

- \`{QUEUE}\` (defaults to \`.agentic/queue.md\`: Ralph execution queue.
- \`{PROGRESS}\` (defaults to \`.agentic/progress.txt\`: path progress file from workspace root.

The queue maintains a bulleted list of checkable tasks, with format:

> \`- [ ] {TYP}-{NUM} - {TASK} ({REF})? …\`

Where:
- \`{TYP}\` task type
- \`{NUM}\` task number
- \`{TASK}\` description
- \`{REF}\` optional reference documentation

## Workflow

1. Pick up the first unchecked task (\`- [ ]\`) from \`{QUEUE}\`.
2. Read PROGRESS for context.
3. Follow TYP-specific task rules (see \`### Tasks\` below) .
4. When done, check task in \'{QUEUE}\`.
5. Persist any learnings or findings in \`{PROGRESS}\`.

### Tasks

- \`FIX-\` tasks
- \`TASK-\` or any other tasks: default processing.

### TASK or default tasks

- If REF is specified:
  - Follow instructions from \`{REF}\`.
  - Commit your work with \`git add . && git commit -m "{TYP}-{NUM} - {a short description}"\`
- Otherwise, this is a simple inline task:
  - Follow instructions as worded by \`{TASK}\`.
  - Check inline task when done.

### FIX tasks

- This is a FIX task:
- Check either of the following files exist:
  - \`__build.log\`: read and fix build failures.
  - \`__test.log\`: read and fix failed tests.

### Rules

- Pick the first **unchecked** task.
- Focus on that **ONE** task only.
- Check the task when done with (\`- [x]\`).
- NEVER consider later tasks.
- NEVER delegate later tasks.
`,
);
files.set(
  "BLUEPRINT.md",
  "# Blueprint\n\n- [ ] TASK-001 - Define first task\n",
);

export const blueprintContinuationLowering: ContinuationLowering = {
  name: "blueprint",
  schema: {
    required: ["source"],
    properties: {
      source: { type: "string", minLength: 1 },
      completeWhenSourceExhausted: { type: "boolean" },
    },
  },
  lower: (dto, ctx) => {
    const continuation = dto as {
      source?: string;
      completeWhenSourceExhausted?: boolean;
    };
    return continuation.source
      ? new ChainedWorkSource(
          [ctx.base, new BlueprintRefill(ctx.source, continuation.source)],
          continuation.completeWhenSourceExhausted ? "complete" : "blocked",
          "Blueprint source exhausted.",
        )
      : ctx.base;
  },
};

export const blueprintTemplateRegistration: TemplateRegistration = {
  name: "blueprint",
  files,
  triggers: [taskAppearsTrigger],
  continuationLowerings: [blueprintContinuationLowering],
};
