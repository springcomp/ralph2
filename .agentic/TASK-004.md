# TASK-004 — Deliver selected task through generated harness prompt

## Objective
Give every goal agent exact assigned work without requiring it to read, select, reorder, or mutate task queue.

## Implementation
1. In `src/config/lowering/steps.ts`, create harness-only per-iteration prompt artifact under `.agentic/`.
2. Build generated prompt with header containing:
   - selected raw task line / task identifier;
   - configured goal path when present;
   - progress path;
   - clear assignment ownership context.
3. Append configured source prompt contents verbatim.
4. Pass generated artifact path as `{PROMPT}` to harness invocation.
5. Keep configured source prompt immutable and do not interpolate arbitrary placeholder syntax contained inside it.
6. Preserve current verification prompt rendering as separate artifact and behavior.

## Acceptance criteria
- Harness receives generated prompt containing exact selected task and original prompt content.
- Goal and progress paths appear in generated header when configured.
- Source prompt file remains byte-for-byte unchanged.
- Verification prompt still renders independently from normal harness prompt.
- Prompt materialization failures become ordinary, diagnosable workflow failures.
