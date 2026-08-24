# Ralph Findings: M1 Task Verification and Sequencing

## Scope

Reviewed Ralph source under `../ralph2/`, especially:

- `src/core/engine.ts`
- `src/core/markdown-task-source.ts`
- blueprint workflow tests

Compared behavior with M1 orchestration requirements in the XSLT repository.

## Task identity finding

Ralph captures the task selected before agent execution:

```ts
const original = task;
```

Verification uses that original task for prompt values:

```ts
let verifyValues = this.values(plan, original, options, iteration);
```

Therefore verification is intended to assess the task the coding agent originally received from PRD, not a later `FIX-*` task.

## Bug: unchecked detection uses first unchecked task

Current `stillUnchecked()` implementation calls:

```ts
const task = await this.source.getFirstUncheckedTask(path);
```

It then compares that one task with `original`.

Failure case:

1. Agent starts `TASK-009`.
2. Agent leaves `TASK-009` unchecked.
3. A `FIX-*` task is inserted before `TASK-009`.
4. `getFirstUncheckedTask()` returns `FIX-*`.
5. `stillUnchecked(PRD, original)` returns false.
6. Ralph incorrectly concludes original `TASK-009` is no longer unchecked.

This can bypass verification failure handling or allow progression while the original task remains unchecked.

## Required source fix

Replace first-unchecked comparison with exact-task lookup. Ralph needs an operation equivalent to:

```ts
isTaskUnchecked(path, target): Promise<boolean>
```

It must search all parsed tasks and compare stable task identity plus original raw-line identity, then return whether that exact task remains unchecked.

Do not use first-unchecked selection to determine completion of a previously selected task.

## Context finding

After agent execution, Ralph refreshes `task` from first unchecked PRD task before running `postAgent` stages. Therefore post-agent placeholders can refer to a newly inserted `FIX-*`, rather than the original task.

This is risky. Build/test/evidence stages should normally retain original-task context, while remediation should be scheduled for the next iteration. If current behavior remains intentional, every post-agent stage must explicitly document whether it consumes original-task or current-queue context.

Recommended contexts:

- agent: original task;
- build/test/acceptance/verification: original task;
- remediation scheduling: failed original task plus failure artifact;
- next iteration: newly scheduled `FIX-*` task.

## Verification ordering

Safe ordering is:

```text
preAgent
agent(original task)
postAgent deterministic gates
verification(original task)
completion/evidence gate
schedule next Blueprint task
```

Verification before build/test is unsafe because an agent can mark a task complete before deterministic checks run.

Moving verification after `postAgent` stages is necessary, but not sufficient by itself.

## Does exact identity fix plus postAgent-before-verification satisfy M1 orchestration?

**No, not by itself.** It satisfies the basic task-identity and ordering requirement, but M1 requires more than checking the PRD checkbox.

For M1 bounded one-feature-at-a-time execution, Ralph must also enforce these deterministic gates before scheduling the next Blueprint task:

1. Build succeeds with zero warnings where required.
2. Tests pass.
3. Skipped tests fail the gate unless explicitly and narrowly allowlisted. XL10 acceptance fixtures must not silently skip.
4. Task-specific acceptance fixtures exist and pass.
5. Required positive and negative/error cases execute.
6. Diagnostic code, severity, phase, trigger, and source location match contract.
7. Oracle comparison passes where `XslCompiledTransform` is available.
8. Unavailable oracle cases have explicit reviewed expected results and are not reported as parity passes.
9. Sync/async parity passes where API applies.
10. Dependency gates are already verified.
11. Scope/evidence checks pass.
12. Working tree has the required clean commit.
13. Original task is checked only after all gates pass.

The current Ralph core has generic process exit-code handling and checkbox verification. It does not inherently provide all M1 conformance checks.

## Required completion condition

Scheduling the next Blueprint task must require all of:

```text
original task verified checked
build passed
tests passed
skipped count acceptable
M1 acceptance passed
oracle passed or reviewed-unavailable
 diagnostics passed
sync/async parity passed where applicable
dependencies passed
clean commit present
```

A checkbox alone must not authorize Blueprint advancement.

## Recommended Ralph control flow

```text
select original = first unchecked PRD task
run preAgent(original)
run agent(original)

run postAgent stages with original context
if any stage fails:
    schedule remediation tied to original and artifact
    do not schedule next Blueprint task
    continue next loop

run verification(original)
if original remains unchecked:
    run bounded verification retry against original
if original remains unchecked:
    block; do not schedule next Blueprint task

run task evidence/oracle/diagnostic gates against original
if any gate fails:
    schedule remediation tied to original
    do not schedule next Blueprint task

only now seed/schedule next Blueprint task
```

## Final verdict

After fixing exact-task lookup and moving verification after post-agent stages, Ralph becomes structurally suitable for the M1 gated sequence, provided deterministic M1 acceptance gates are added and made hard prerequisites for Blueprint advancement.

Without those additional gates, Ralph is suitable only for build/test task automation, not trustworthy M1 compatibility completion.
