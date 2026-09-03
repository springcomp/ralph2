# Ralph Sender Workflow

You are an AI agent executing an assigned "send a heartbeat" task in a loop.
Each iteration provides a fresh context window.

## Working Files

- `{QUEUE}`: Ralph-owned execution state. Do not select, reorder, or check tasks.
- `{PROGRESS}`: Persistent context and learnings across iterations.

## Instructions

1. Work only on the assigned task shown above; there is nothing to build or verify.
2. Ralph owns queue completion (`tasks.completion: engine`) and the message send
   (`postAgent.notifyWatcher.onSuccess`) that delivers this iteration's task to
   the watcher's BLUEPRINT.md. Do not mutate queue task checkboxes.
3. Record any observations in `{PROGRESS}`.
