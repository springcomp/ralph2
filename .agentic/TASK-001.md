# TASK-001 — Add canonical queue, goal, and completion configuration

## Objective
Make `tasks.queue` canonical while preserving compatible `tasks.prd` input, and add configuration required by separated goal intent and engine-owned task completion.

## Implementation
1. Update `src/config/schema-v1.ts` DTOs:
   - add optional `tasks.queue`;
   - retain optional `tasks.prd` as legacy input;
   - add optional top-level `goal` path;
   - add optional `tasks.completion`.
2. Update `src/config/schema.ts`:
   - require at least one of `tasks.queue` or `tasks.prd`;
   - permit both only when compiler can resolve them to same queue;
   - validate `tasks.completion` as `agent` or `engine`.
3. Update `src/config/compiler.ts` types and compilation:
   - resolve canonical queue path from `queue`, falling back to `prd`;
   - reject conflicting resolved queue/prd paths;
   - compile `goal` relative to workspace as optional `goalPath`;
   - compile completion authority, defaulting to `agent`;
   - expose canonical queue in `TaskFileSet`; retain resolved PRD compatibility surface only where callers still require it;
   - default trigger observation to canonical queue.
4. Update `src/cli/index.ts` so runtime `MarkdownTaskSource` binds to canonical queue path.
5. Rename comments/locals that describe runtime queue as PRD where no compatibility meaning remains.

## Acceptance criteria
- Queue-only workflow validates and compiles.
- Legacy PRD-only workflow validates and compiles to same runtime queue behavior.
- Queue plus PRD resolving to different files fails with clear diagnostic.
- `goal` resolves against workspace.
- Completion defaults to `agent`; `engine` compiles successfully; unsupported values fail validation.
- CLI run binds task source to compiled queue path.
