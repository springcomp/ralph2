# Blueprint watcher sample

This sample waits for unchecked tasks appended to the human-authored
`BLUEPRINT.md`. Ralph refills the execution `queue.md` from that source.
Initialize it with `ralph init --template blueprint`, or copy these files into
`.agentic/`, then run:

```bash
ralph run --config .agentic/ralph.yaml
```

Append a task while the workflow is waiting:

```bash
printf "%s\n" "- [ ] TASK-002 - Handle an added task while watching" >> .agentic/BLUEPRINT.md
```
