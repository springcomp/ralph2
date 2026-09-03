# Blueprint sample

A finite blueprint workflow: Ralph refills `queue.md` from the human-authored
`BLUEPRINT.md` and completes (exit code 0) once the blueprint is fully
drained (`completeWhenSourceExhausted: true`). Uses `stunt`
([../../src/stunt/index.ts](../../src/stunt/index.ts)), a fake AI harness, so
it runs without any external AI CLI. Run directly from the repo root:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprint/ralph.yaml
```

See also [../blueprint-watcher](../blueprint-watcher/README.md) (same idea,
but waits for new tasks instead of completing) and
[../blueprints](../blueprints/README.md) (focused samples covering
completion-ownership and exhaustion-behavior combinations).
