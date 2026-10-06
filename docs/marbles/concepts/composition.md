---
title: Composition
description: Build a definition once, lock it into a tree as often as needed.
---

A definition has two phases. Build: `step(name).input(schema).output(schema).do(fn)`
shapes it, and nothing is in a graph yet. Lock: calling it,
`review({}, { target: "." })`, makes one node with these children and this
literal input. One definition can be locked many times; each lock is its own
node.

```ts
const weekly = workflow(
  "weekly",
  publish.parallel({
    findings: review({}, { target: "packages" }),
    exitCode: test({}),
  })
);
```

```text
weekly (publish)
├─ findings   review { target: "packages" }
└─ exitCode   test
```

| Call | Children run |
| --- | --- |
| `publish(children, input?)` | In key order. |
| `publish.series(children, input?)` | In key order, written out. |
| `publish.parallel(children, input?)` | Together. |

The rules that follow from this shape:

- **Children first, input second.** An object of locked nodes keyed by name,
  then literal values for the step's own input. The two merge into the
  parent's `input`; a key in both is an error when the module loads.
- **Keys name steps.** `findings` and `exitCode` are the children's names in
  the dashboard, in logs, on resume, and in the parent's schema.
- **The parent runs last** and declares its children's results in `.input()`
  like any other input. Each child's output is checked against its key at
  lock.
- **Siblings are independent.** Data flows only from a child to its parent.
  A step that needs another's result takes it as a child, which is how a
  chain reads: `approve({ review: review({ branch: implement({}, { task }) }) })`.
- **A workflow is a name around a tree.** `workflow("weekly", tree)` makes the
  tree launchable and schedulable. `workflow("ship").input(schema).do(setup)`
  builds the tree from input. A workflow is a definition too: `weekly({})`
  locks it, which is what a monitor handler returns to start it.
- **Setup is not durable.** A workflow's `.do` runs on every setup, including
  after a restart, and returns the tree. Anything it must keep goes into a
  step as input, which the run records.

Deterministic and agentic steps share the tree. An implementation turn in a
worktree can hand its branch to a review turn, which hands its findings to an
approval. Series and parallel are the two combinators today; race, branch,
and loops are not available yet.

Continue with [a working tree](/marbles/guides/workflows), or see the
[API reference](/marbles/reference/api#locking-and-trees).
