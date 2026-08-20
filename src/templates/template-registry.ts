export type TemplateName = "goal" | "blueprint";

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

const goal = `${common}
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

const blueprint = `${common}
continuation:
  kind: blueprint
  source: .agentic/BLUEPRINT.md
  seedPrdFromSource: true
  completeWhenSourceExhausted: true
`;

export const templates = Object.freeze({
  goal: Object.freeze({
    "ralph.yaml": goal,
    "ralph.prompt.md": "Follow instructions from .agentic/PRD.md.\n",
    "PRD.md": "# Product Requirements\n\n- [ ] GOAL-001 - Define first goal\n",
    "progress.txt": "# Progress\n\n",
  }),
  blueprint: Object.freeze({
    "ralph.yaml": blueprint,
    "ralph.prompt.md": "Follow instructions from .agentic/PRD.md.\n",
    "PRD.md": "# Product Requirements\n\n",
    "progress.txt": "# Progress\n\n",
    "BLUEPRINT.md": "# Blueprint\n\n- [ ] TASK-001 - Define first task\n",
  }),
});

export function getTemplate(
  name: string,
): (typeof templates)[TemplateName] | undefined {
  return name.toLowerCase() in templates
    ? templates[name.toLowerCase() as TemplateName]
    : undefined;
}
