# TASK-005 — Split built-in templates into goal intent and queue state

## Objective
Make built-in goal template expose user-owned outcome while treating queue as Ralph-owned execution state; migrate blueprint terminology without changing blueprint semantics.

## Implementation
1. Rewrite `src/extensions/templates/goal.ts`:
   - configure `tasks.queue: .agentic/queue.md`;
   - configure `tasks.completion: engine`;
   - configure `goal: .agentic/GOAL.md`;
   - disable agent checkbox verification (`requireTaskChecked: false`);
   - create `GOAL.md` template for outcome, constraints, and acceptance criteria;
   - create queue file with Ralph-owned execution-state header;
   - update seed task to direct first agent to goal file;
   - update prompt to use assignment header and prohibit queue selection/reordering/checking.
2. Update `src/extensions/templates/blueprint/index.ts`:
   - use queue config/file names and `{QUEUE}` terminology;
   - retain BLUEPRINT authoring, agent-owned checking, refill, and watcher behavior.
3. Update task-appears trigger and action descriptions that call queue a PRD.

## Acceptance criteria
- Goal init creates `GOAL.md`, `queue.md`, prompt, progress, and config; it does not create `PRD.md`.
- Goal config uses engine completion and explicit goal path.
- Goal instructions direct agent to assigned task/GOAL/progress and forbid queue mutation.
- Blueprint template uses canonical queue names but still instructs agent to check completed queue tasks.
- Blueprint source refill and watcher configuration remain functionally unchanged.
