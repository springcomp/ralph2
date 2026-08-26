# TASK-002 — Add queue and goal placeholders

## Objective
Expose canonical queue and goal paths to commands/prompts while retaining `{PRD}` compatibility.

## Implementation
1. Update `src/placeholders/placeholders.ts`:
   - add `{QUEUE}` with task-queue path description;
   - add `{GOAL}` with optional goal-intent path description;
   - retain `{PRD}` as deprecated alias that expands to queue path;
   - include supported placeholders in normal and conditional argument validation where appropriate.
2. Extend `PlaceholderContext` with queue and goal fields while retaining PRD compatibility.
3. Populate canonical values in `compileCore` context creation and `src/config/lowering/steps.ts` stage context construction.
4. Update placeholder documentation/descriptions to identify PRD as compatibility-only.

## Acceptance criteria
- `{QUEUE}` expands to resolved queue path.
- `{GOAL}` expands to resolved goal path, or empty string when absent.
- `{PRD}` expands to same queue path as `{QUEUE}`.
- Unknown-placeholder validation recognizes new placeholders and still rejects unknown names.
- Conditional arguments can safely use supported new placeholders.
