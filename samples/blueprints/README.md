# Blueprint workflow combinations

Focused, runnable samples demonstrating the meaningful combinations for a
`continuation.kind: blueprint` workflow. Each uses `stunt`
([../../src/stunt/index.ts](../../src/stunt/index.ts)), a fake AI harness
that stands in for a real coding agent so these samples run without any
external AI CLI.

Blueprint continuations always seed `queue.md` from `BLUEPRINT.md` (there is
no way to disable this — an unseeded blueprint file is never read anywhere,
so making it optional was a footgun). Two axes remain worth demonstrating:

- **Completion ownership** (`tasks.completion`): `agent` (default, a human or
  the harness checks the task) vs `engine` (Ralph checks it automatically
  after the pipeline succeeds).
- **Exhaustion behavior** (`continuation.completeWhenSourceExhausted`): `true`
  (a bounded blueprint — draining it means the whole thing is done, exit 0)
  vs `false`, the default (an ongoing backlog — draining it just means
  "nothing to do *right now*", exit 3, "blocked").

| Sample | completion | completeWhenSourceExhausted |
| --- | --- | --- |
| [agent-owned-finite](agent-owned-finite/README.md) | agent | true |
| [engine-owned-finite](engine-owned-finite/README.md) | engine | true |
| [agent-owned-cron](agent-owned-cron/README.md) | agent | false (default) |

See also [../blueprint-watcher](../blueprint-watcher/README.md) for the
related but orthogonal `trigger: taskAppears` (resident, in-process waiting)
pattern, and [addTask](addTask/README.md) for the send-side counterpart:
an `onSuccess`/`messages` hook that delivers tasks into
[agent-owned-watcher](agent-owned-watcher/README.md)'s BLUEPRINT.md from a
separate, independently-running Ralph instance.
