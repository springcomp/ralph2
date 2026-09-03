# agent-owned-finite

Demonstrates: `tasks.completion: agent` (default) + `completeWhenSourceExhausted: true`.

BLUEPRINT.md holds two backlog tasks. Ralph refills `queue.md` from BLUEPRINT.md
whenever the queue drains. The `stunt` harness (a fake AI agent, see
[../../../src/stunt/index.ts](../../../src/stunt/index.ts)) simulates the agent
by checking off its own task (`--check`) — the same thing a real coding agent
would do by editing the queue file.

Run from the repo root:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprints/agent-owned-finite/ralph.yaml
```

What to watch for: both `- [ ]` lines in `BLUEPRINT.md` flip to `- [x]` across
iterations, and the run exits with code **0** ("complete") once the blueprint
is fully drained.
