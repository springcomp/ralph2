# TASK-007 - Phase 6: Docs and cleanup

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 6 and "Verification" section.

Close out the refactor with documentation and a final full verification pass.

## Implementation steps

1. Rewrite [DESIGN.md](../DESIGN.md) around the three layers (surface / lowering /
   core), per the separately approved outline referenced in the plan.
2. Remove any now-stale references to the old fat-plan internals elsewhere in the repo
   (comments, other docs) that describe the removed `handleFailure` / continuation
   branches.
3. Run the full verification checklist from the plan:
   - `pnpm vitest run` green.
   - `grep -E "blueprint|goal|verification|trigger|preAgent|postAgent"
     src/core/engine*.ts` → empty.
   - `samples/*/ralph.yaml` run unchanged via `bootstrap/ralph.js`.
   - Event-stream snapshot for a sample run identical pre/post refactor.
   - `pnpm biome check` clean; coverage not decreased vs. `coverage/coverage-summary.json`.

## Acceptance criteria

- [ ] `DESIGN.md` documents the surface / lowering / core layering and matches the
      approved outline.
- [ ] No stray references to deleted fat-plan internals remain in docs or comments.
- [ ] All six verification checks in the plan's "Verification" section pass.
- [ ] `pnpm vitest run` and `pnpm biome check` are green; coverage has not decreased.
