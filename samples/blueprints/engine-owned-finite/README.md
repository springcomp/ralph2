# engine-owned-finite

Demonstrates: `tasks.completion: engine` + `completeWhenSourceExhausted: true`.

Same blueprint refill behavior as
[../agent-owned-finite](../agent-owned-finite/README.md), but here Ralph
itself checks each task off after the pipeline succeeds — the `stunt` harness
(see [../../../src/stunt/index.ts](../../../src/stunt/index.ts)) is invoked
**without** `--check`, so it never touches the checkbox. This requires
`verification.requireTaskChecked: false` (enforced by config validation),
since a verify step that expects the agent to have checked the task would
always fail here.

Run from the repo root:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprints/engine-owned-finite/ralph.yaml
```

What to watch for: after the harness step runs, the current task in
`queue.md`/`BLUEPRINT.md` is still `[ ]` — it only flips to `[x]` once the
whole iteration (including the engine's own completion step) finishes. The
run exits with code **0** once the blueprint is fully drained.
