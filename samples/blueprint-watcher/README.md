# Blueprint watcher sample

This sample waits for unchecked tasks appended to the human-authored
`BLUEPRINT.md`. Ralph refills the execution `queue.md` from that source. It
uses `stunt` ([../../src/stunt/index.ts](../../src/stunt/index.ts)), a fake
AI harness, so it runs without any external AI CLI. Run directly from the
repo root:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprint-watcher/ralph.yaml
```

Append a task while the workflow is waiting (from another terminal):

```bash
printf "%s\n" "- [ ] TASK-002 - Handle an added task while watching" >> samples/blueprint-watcher/BLUEPRINT.md
```

See also [../blueprints](../blueprints/README.md) for the non-watching
(finite / cron) completion-behavior samples.
