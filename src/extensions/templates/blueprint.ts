import type { TemplateRegistration } from "../registry.js";
import { goalTemplateRegistration } from "./goal.js";

const blueprintYaml = `schemaVersion: 1

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

continuation:
  kind: blueprint
  source: .agentic/BLUEPRINT.md
  seedPrdFromSource: true
  completeWhenSourceExhausted: true
`;

const files = new Map(goalTemplateRegistration.files);
files.set("ralph.yaml", blueprintYaml);
files.set("PRD.md", "# Product Requirements\n\n");
files.set(
  "BLUEPRINT.md",
  "# Blueprint\n\n- [ ] TASK-001 - Define first task\n",
);

export const blueprintTemplateRegistration: TemplateRegistration = {
  name: "blueprint",
  files,
};