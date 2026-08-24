# Ralph Feature: Deterministic Post-Agent Gates

## Purpose

Allow Ralph workflows to run deterministic checks after an agent, verify the agent's original task, and advance continuation only when all required checks pass.

Target lifecycle:

```text
select original task
preAgent
agent
postAgent deterministic gates
verification of original task
completion decision
continuation / next task
```

This feature is workflow-generic. Domain-specific checks belong in configured scripts, not in Ralph core.

## Current behavior

`WorkflowEngine` captures the selected task as:

```ts
const original = task;
```

Verification builds values from `original`, so verification is intended to target the task selected before agent execution.

However, after agent execution Ralph refreshes the first unchecked task and replaces `values`. This can make `postAgent` and continuation stages receive a later remediation task instead of the original task.

Also, `stillUnchecked()` calls `getFirstUncheckedTask()`. If a remediation task is inserted before the original task, Ralph can incorrectly conclude that the original task is no longer unchecked.

## Required behavior

### Original task identity

Capture immutable original task values at iteration start:

```ts
const original = task;
const originalValues = this.values(plan, original, options, iteration);
```

Use `originalValues` for:

- agent;
- post-agent checks;
- verification;
- failure-task expansion;
- task-specific artifacts.

A remediation task belongs to the next iteration and must not replace current iteration context.

### Exact task state

Add an operation equivalent to:

```ts
isTaskUnchecked(path: string, target: MarkdownTask): Promise<boolean>
```

It must search all parsed tasks and identify the exact original task. It must not use first-unchecked selection for completion checks.

Required cases:

- original task checked;
- original task still unchecked;
- remediation inserted before original;
- original task missing or changed.

### Post-agent gates

Post-agent stages may be deterministic gates. Each stage must:

- run with original task context;
- emit a machine-readable result when useful;
- return a failing exit code when its gate fails;
- preserve logs and artifacts;
- declare whether failure is recoverable by a remediation task.

If a mandatory stage fails:

```text
schedule remediation
stop current completion path
skip verification success
skip continuation
process remediation in a later iteration
```

A failure action that schedules remediation must not allow the workflow to advance in the same iteration.

### Verification

Verification is a recovery step when agent work may be complete but original task remains unchecked. It is not a replacement for deterministic gates.

Run verification only after mandatory post-agent stages pass. Pass original task values to verification. If original task remains unchecked after retries, block progression.

### Continuation

Continuation or next-task scheduling requires:

```text
original task exact lookup = checked
all mandatory post-agent gates = passed
verification = passed or not required
required evidence = passed
```

A checkbox alone must not authorize continuation.

## Configuration model

Existing `postAgent` stages can host domain-specific checks:

```yaml
postAgent:
  - name: build
    executable: ./scripts/build.ps1
    onFailure:
      action: scheduleTask
      task: "- [ ] FIX-{ITERATION:000} - Build failed for {TASK}"
```

This is sufficient as an execution mechanism if Ralph guarantees:

1. original placeholders remain stable;
2. failure blocks continuation;
3. remediation runs in a later iteration;
4. verification checks the original task;
5. result artifacts can be consumed by later checks or humans.

Ralph core need not know domain meanings such as oracle, diagnostics, coverage, or fixture conformance. Those are script responsibilities.

## Remediation task identity

Failure tasks should identify their parent task and artifact:

```text
- [ ] FIX-001 - Check failed for TASK-009 (parent: TASK-009)
```

Prefer structured result artifacts containing:

```json
{
  "taskId": "TASK-009",
  "stage": "check",
  "status": "failed",
  "iteration": 1,
  "parentTaskId": "TASK-009",
  "artifact": ".agentic/results/001/check.json"
}
```

## Acceptance tests

Add workflow tests proving:

1. post-agent stages receive original task placeholders;
2. remediation inserted before original does not fool exact task lookup;
3. failed mandatory stage prevents verification success and continuation;
4. remediation is processed in a later iteration;
5. verification receives original task context;
6. all mandatory stages pass before continuation;
7. continuation seeds the next task exactly once;
8. malformed or missing required result artifact blocks progression.

## Non-goals

Ralph core does not need built-in knowledge of:

- a particular programming language;
- a particular test framework;
- oracle implementations;
- diagnostic formats;
- coverage policy;
- project milestones;
- project-specific directory layouts.
