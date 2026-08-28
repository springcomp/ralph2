# Ralph & Graph Engineering — findings for future refactoring

Status: analysis / not yet implemented. Captured for future graph-layer work.

## Sources

- Graph engineering walkthrough (primary): https://www.ayautomate.com/resources/graph-engineering
- Escalation ladder origin: aibuilderclub Graph Engineering Guide
  https://www.aibuilderclub.com/blog/graph-engineering-guide-2026

Reference framing: "graph engineering" escalation ladder
`prompt → context → harness → loop → graph`
(source: aibuilderclub Graph Engineering Guide; walkthrough at
https://www.ayautomate.com/resources/graph-engineering).

A graph is defined as **three** things — not just "many nodes":

- **Nodes** — specialized agents *or* deterministic steps, one job each.
- **Edges** — routed work between nodes: straight, conditional, fan-out, fan-in, loop-back.
- **Shared state** — one object every node reads and writes.

Graph signals (vs. a loop): 2+ specialized roles handing off, branching work,
parallel independent parts, human approval gate mid-task.

## 1. Where ralph stands today

Ralph today = **loop engineering**, one rung below graph — but with branching, so
it is "a loop that learned to branch."

A single ralph instance = **one node**: a specialized harness agent wrapped in
deterministic pre/post steps + self-heal loop. Article allows this: a node can be
"a specialized agent *or* a deterministic step." Ralph fuses both.

What ralph already has (graph-ish bones):

- **Shared state** — `CoreContext` travels the pipeline; markdown tracking files
  (queue, progress, GOAL.md) act like AY's `BOARD.md` / `HANDOFFS.md`.
- **Loop-back / real self-heal** — `Policy` (`retry`, `schedule`, remediation) +
  circuit breaker. Remediation changes the plan, not blind retry — this matches
  the article's "*real* recovery, not silent recovery."
- **Conditional edges** — verification retry, `onFailure` schedule, guard trip →
  block. That is genuine branching.

What a single instance lacks for a true graph:

- No multiple specialized *agent* nodes (one harness per iteration).
- No fan-out / fan-in (pipeline is sequential `Step[]`).
- No arbitrary node→node routing (edges are linear stages + retry loops).
- Verification reuses the *same* harness, not a distinct reviewer agent.

Per the article decision table, a single ralph sits in the "loop is enough" column.

## 2. Multi-instance ralph — when it becomes a graph

Many nodes alone ≠ graph. Graph is the *wiring* (edges + shared state). Three
topologies:

1. **Parallel independent instances** (own queue, own scope) — **NOT a graph.**
   Fan-out with no fan-in, no shared state. Just concurrent loops / a fleet.
2. **Pipeline of instances** (planner-ralph → coder-ralph → reviewer-ralph, where
   one instance's output feeds the next) — **YES, a graph.** Straight edges +
   handoff.
3. **Instances sharing one tracking layer + routing failures back** (planner
   routes tasks to worker instances; reviewer loops failures upstream) —
   **YES, full graph.** Nodes + edges + shared state + loop-back. This is the AY
   swarm shape.

### Key insight — ralph already has an edge primitive

Ralph's **`trigger: taskAppears` + markdown queue** is a directed edge:

- **edges** = trigger-on-file (instance B wakes when instance A writes a task line)
- **shared state** = markdown tracking files (queue, progress, GOAL.md)
- **loop-back** = reviewer instance re-opens a task (uncheck line) → upstream
  trigger fires again
- **fan-out** = one producer instance seeds N worker queues
- **fan-in** = N workers write one shared progress file that a gate instance watches

So multi-instance ralph **can** be a graph — but the graph currently lives in how
triggers + shared markdown are wired, not in ralph core. Ralph core stays a node;
the graph is *emergent from wiring, not managed*.

## 3. Gaps to close for a real graph engine

To move from "emergent graph" to a managed graph layer, ralph needs:

- **Declared router / topology** — edges are implicit (file polling) today. Need a
  single declared place: "node A → node B on condition X" (conditional, fan-out,
  fan-in, loop-back).
- **Cross-instance shared-state contract** — each instance owns its own `.agentic/`
  state. Cross-instance handoff is hand-wired shared files → risks **state drift**
  (nodes disagree on the shape of shared data). Need one shared tracking-layer
  schema.
- **Cross-instance lock protocol** — ralph locks its *own* workspace only. Two
  instances editing the same repo = **node isolation gone wrong**. Need one lock
  per task, committed before writes, honored across instances.
- **Graph-level observability** — each instance reports only its own events.
  Nothing aggregates a whole graph run.
- **Distinct reviewer/adversarial node** — verification currently reuses the same
  harness. A real graph wants a separate reviewer agent node.
- **Parallel fan-out/fan-in in core** — the pipeline is sequential; independent
  tasks cannot run concurrently and rejoin.

## 4. Production failure modes to design against

From the article, the three ways production graphs break (and the mitigation ralph
would need):

- **State drift** — two nodes write the same field with different shape
  assumptions. Mitigation: one shared tracking-layer schema, not per-agent formats.
- **Node isolation gone wrong** — a scoped worker writes outside its lane and
  collides. Mitigation: lock-file protocol (one lock per task, committed before
  writes).
- **Silent recovery, not real recovery** — a loop-back retries the same failing
  input unchanged. Mitigation: recovery must change prompt/context/plan and log
  why (ralph remediation already does this within a single instance; must extend
  across instances).

## 5. Suggested direction

A thin **graph layer over ralph instances**, keeping ralph core as the node:

- Treat each ralph instance as a node with a typed role (planner / worker /
  reviewer / gate).
- Declare topology + routed edges explicitly (extend the existing `trigger` +
  extension registry rather than branching the core interpreter).
- Formalize a shared tracking-layer schema + cross-instance lock protocol.
- Add graph-level event aggregation.

Ralph's shared-state + tracking-file + self-heal foundation is already the right
shape to grow into this. Bones are good; the graph is not managed yet.
