# TASK-006 - Phase 5: Extensibility hook for lowering

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 5.

Let each continuation strategy / trigger / circuit breaker register its own lowering
alongside its runtime callback, so adding a new kind never requires editing core.

## Implementation steps

1. Extend `src/extensions/registry.ts` and `src/extensions/types.ts` with a lowering
   hook per extension kind, e.g.:
   ```ts
   interface ContinuationLowering {
     name: string;                 // "blueprint" | "goal"
     schema: DtoFragment;          // friendly YAML shape (surface)
     lower(dto, ctx): WorkSource;  // frontend -> IR
   }
   ```
   Mirror the equivalent shape for triggers and circuit breakers where applicable.
2. Migrate the Phase 2 hand-written lowering for `blueprint` / `goal` continuation,
   triggers, and circuit breakers in `src/extensions/{producers,triggers,
   circuit-breakers,predicates,actions}` to register through this hook instead of being
   special-cased in `src/config/lowering/*`.
3. Update `src/config/compiler.ts` / lowering modules to resolve lowering via the
   registry lookup instead of hardcoded branches per kind.
4. Add a test that registers a new dummy continuation/trigger kind purely through the
   registry and confirms `compileCore()` picks it up without any change to
   `src/config/lowering/*` or `src/core/*`.

## Acceptance criteria

- [ ] Registry exposes a lowering hook consumed by `compileCore()`.
- [ ] Built-in `blueprint`, `goal`, trigger, and circuit-breaker kinds are lowered via
      the registry hook, not hardcoded branches.
- [ ] A new dummy extension kind can be added and lowered without touching
      `src/core/*`.
- [ ] `pnpm vitest run` and `pnpm biome check` stay green.
