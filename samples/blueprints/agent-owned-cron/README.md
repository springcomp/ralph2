# agent-owned-cron

Demonstrates: `tasks.completion: agent` (default) + `completeWhenSourceExhausted`
**omitted** (defaults to `false`), no `trigger`.

BLUEPRINT.md holds a single task. Once it's processed and the blueprint
drains, Ralph has no more work and no trigger to wait on — this is the
"cron/batch" pattern: the run exits with code **3 ("blocked")**, not 0
("complete"). That distinction matters for an external scheduler (cron, a
scheduled CI job) that re-invokes `ralph run` periodically against a living
backlog: "blocked" means "nothing to do *this cycle*", not "this project is
finished forever". Add another task to `BLUEPRINT.md` and re-run to see it
pick up again.

Run from the repo root:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprints/agent-owned-cron/ralph.yaml
echo "exit code: $LASTEXITCODE"   # PowerShell; use $? on bash
```

What to watch for: `BLUEPRINT.md`'s task flips to `- [x]`, then the process
exits with code **3**, not 0.
