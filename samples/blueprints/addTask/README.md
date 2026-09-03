# addTask

Demonstrates: the `onSuccess`/`messages` extension point — the send-side
counterpart to `trigger`. Every iteration, this sender generates a heartbeat
task (`continuation.kind: generatedGoal`, engine-owned completion), and once
its `notifyWatcher` postAgent stage succeeds, `onSuccess` fires the built-in
`addTask` message, appending a new checkable task straight into
[../agent-owned-watcher](../agent-owned-watcher/README.md)'s `BLUEPRINT.md`.

```yaml
postAgent:
  - name: notifyWatcher
    onSuccess:
      message: addTask
      target: "../agent-owned-watcher/BLUEPRINT.md"
      task: "- [ ] MSG-{ITERATION:000} - Heartbeat from addTask sender at iteration {ITERATION}"
```

`completeWhen` points at a `STOP.flag` file that's never created, so the
sender keeps generating and sending one heartbeat per iteration until
`maxIterations` — pair it with `agent-owned-watcher`'s `trigger: taskAppears`
(idling on that same `BLUEPRINT.md`) to see a full message round trip between
two independently-running Ralph instances, connected only through a shared
Markdown file.

Run both from the repo root, in two terminals:

```bash
pnpm build
node bootstrap/ralph.js run --config samples/blueprints/agent-owned-watcher/ralph.yaml
node bootstrap/ralph.js run --config samples/blueprints/addTask/ralph.yaml
```

What to watch for: `agent-owned-watcher/BLUEPRINT.md` gains a new `MSG-*` line
each time the sender's postAgent stage succeeds, and the watcher (idling on
`trigger: taskAppears`) picks each one up and processes it without a restart.

To stop the sender early, create `samples/blueprints/addTask/STOP.flag`.
