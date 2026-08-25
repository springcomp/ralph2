# BLUEPRINT

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md)

- [x] TASK-001 - Phase 0: Baseline safety net — green suite + golden tests for verification retry, remediation cap, trigger, circuit breaker (ref: `TASK-001.md`)
- [x] TASK-002 - Phase 1: Core vocabulary types (`CorePlan`, `Step`, `Policy`, `WorkSource`, `Guard`, `Predicate`) in `src/core/plan.ts` (ref: `TASK-002.md`)
- [x] TASK-003 - Phase 2: Compiler lowering — buckets/policy/verify-step and WorkSource composition into `compileCore()` (ref: `TASK-003.md`)
- [x] TASK-004 - Phase 3: New tiny engine — `pipeline.ts` + `engine-core.ts` over `CorePlan`, validated against goldens (ref: `TASK-004.md`)
- [ ] TASK-005 - Phase 4: Cutover — CLI uses `compileCore()`/core engine, delete dead fat-plan machinery (ref: `TASK-005.md`)
- [ ] TASK-006 - Phase 5: Extensibility hook — registry-based lowering for continuations/triggers/breakers (ref: `TASK-006.md`)
- [ ] TASK-007 - Phase 6: Docs + cleanup — rewrite `DESIGN.md`, final verification pass (ref: `TASK-007.md`)
