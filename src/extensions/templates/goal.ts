import type { TemplateRegistration } from "../registry.js";

const common = `schemaVersion: 1

workspace: ..
maxIterations: 100

tasks:
  format: markdown
  prd: .agentic/PRD.md
  progress: .agentic/progress.txt
  prompt: .agentic/ralph.prompt.md
  completionSignal: <ralph>COMPLETE</ralph>
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
      - "Follow instructions from {PROMPT}"
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

    Verify work complete. Check task in PRD if complete, or document blockers in progress.txt.
`;

const goalYaml = `${common}
continuation:
  kind: generatedGoal
  producer:
    executable: sh
    arguments:
      - -c
      - "test ! -e .agentic/__remaining_failures.log"
    timeout: 15m
    successExitCodes: [0]
  completeWhen:
    kind: fileMissing
    path: .agentic/__remaining_failures.log
  nextTask: "- [ ] GOAL-{ITERATION:000} - Resolve remaining failures"
`;

export const goalTemplateRegistration: TemplateRegistration = {
  name: "goal",
  files: new Map([
    ["ralph.yaml", goalYaml],
    ["ralph.prompt.md", "Follow instructions from .agentic/PRD.md.\n"],
    [
      "PRD.md",
      "# Product Requirements\n\n- [ ] GOAL-001 - Define first goal\n",
    ],
    ["progress.txt", "# Progress\n\n"],
  ]),
};
