# Patterns for handing work between steps

A parent receives its children's results. Choose results that remain usable
after the producing step finishes: a commit SHA, artifact version, or session
reference. These are focused excerpts, not complete modules; they assume
the authoring imports and role definitions shown in the API reference.

## Contents

1. [A branch name](#a-branch-name)
2. [A worktree path, inside one step only](#a-worktree-path-inside-one-step-only)
3. [An artifact version](#an-artifact-version)
4. [Ask first](#ask-first)
5. [A session across steps](#a-session-across-steps)
6. [A session across runs](#a-session-across-runs)
7. [A monitor that launches](#a-monitor-that-launches)
8. [A parallel fan-in](#a-parallel-fan-in)
9. [A sandbox with a result](#a-sandbox-with-a-result)
10. [Anti-patterns](#anti-patterns)

## A branch name

Pass a branch, not a directory. A worktree lives only inside the callback that
made it; a branch survives the step, the run, and the process. For verification and
approval, also capture its commit SHA and pass that through every stage, so
a moving branch cannot change what is being approved. `run.id` is
`rn-<uuid>`; shorten it if branch names matter.

```ts
const implement = step("implement")
  .input(z.object({ task: z.string() }))
  .output(z.object({ branch: z.string(), revision: z.string() }))
  .do(({ input: { task }, agents, workspaces, exec, run }) => {
    const branch = `task/${run.id}`;
    return workspaces.current.git.withWorktree({ base: "main", branch }, async () => {
      const session = await agents.session(implementer);   // runs in the worktree
      await session.generate(`${task}\n\nCommit when done.`);
      const revision = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      return { branch, revision };
    });
  });
```

The session opened inside the callback inherits the worktree as its working
directory; no `cwd` is passed. Name the branch yourself rather than reading
`worktree.branch`, which is `null` on a detached checkout.

Each intervening step must return the branch and revision if a later step
needs them. The [Software Factory](https://francois-esquire.github.io/foundry/marbles/use-cases/software-factory/)
checks that implementation produced a clean new commit and carries its SHA
through verification and publication.

## A worktree path, inside one step only

When the work and its consumer fit in one step, use the path directly and let
the callback clean up.

```ts
const reviewInWorktree = step("review-in-worktree")
  .input(z.object({ base: z.string().default("main") }))
  .do(({ input: { base }, agents, workspaces, log }) =>
    workspaces.current.git.withWorktree({ base }, async (worktree) => {
      log("reviewing in", worktree.root);
      const session = await agents.session(reviewer);
      return (await session.generate(`Review the checkout of ${base}.`)).text;
    })
  );
```

Never return `worktree.root` to a parent: it is removed when the callback
returns.

## An artifact version

Declare the artifact once so every run adds a version to the same thing.
`report.artifact` writes the version and posts it to the run in one call; the
version id is what a parent gets.

```ts
const weeklyReport = artifact({ name: "Weekly report", type: "text/markdown" });

const publish = step("publish")
  .input(z.object({ findings: z.string(), exitCode: z.number() }))
  .do(async ({ input: { findings, exitCode }, report }) => {
    const version = await report.artifact(weeklyReport, {
      "report.md": `${findings}\n\nTests: ${exitCode}`,
    });
    return version.id;
  });
```

Use `artifacts.create({ name, type, entries })` only for a one-off output that
should not accumulate versions.

## Ask first

A body replays from the top after its `ask` resolves. Ordinary code before the ask executes again; recorded managed operations
can return their earlier results. So a step that asks does nothing else first, and the work that
depends on the answer happens after it or in a step of its own.

The approval input contains the reviewed commit, so the decision identifies
exactly what the person approved:

```ts
const reviewed = z.object({ revision: z.string(), findings: z.string() });

const approve = step("approve")
  .input(z.object({ review: reviewed }))
  .output(z.object({ revision: z.string(), approved: z.boolean() }))
  .do(async ({ input: { review }, ask }) => {
    const decision = await ask.approval({
      title: `Publish ${review.revision}?`,
      body: review.findings,
    });
    return { revision: review.revision, approved: decision.approved };
  });
```

A publishing step consumes this decision and checks that it still matches
the candidate. The [delivery chapter](https://francois-esquire.github.io/foundry/marbles/use-cases/software-factory/development/approve)
shows the full workflow. Launch it from the dashboard so a person can answer.

The same rule covers `question`. A step that asks two things in sequence is
fine: on replay the first call returns the recorded answer and the second one
is the one that suspends.

## A session across steps

Sessions are fresh per `agents.session` call. To let a later step continue an
earlier one's conversation, the earlier step returns `session.ref` (a small
serializable handle) and the later step passes it back.

```ts
const sessionRef = z.object({
  id: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
});

const draft = step("draft")
  .input(z.object({ brief: z.string() }))
  .do(async ({ input: { brief }, agents }) => {
    const session = await agents.session(writer);
    const { text } = await session.generate(brief);
    return { draft: text, session: session.ref };
  });

const revise = step("revise")
  .input(z.object({ first: z.object({ draft: z.string(), session: sessionRef }) }))
  .do(async ({ input: { first }, agents }) => {
    const session = await agents.session(writer, { session: first.session });
    return (await session.generate("Tighten it by a third.")).text;
  });

workflow("write", revise({ first: draft({}, { brief: "…" }) }));
```

The ref carries the provider it opened with. Continuing it with an agent on a
different provider starts a new session and logs a warning.

## A session across runs

Same handle, one run later. The step returns the ref so it is recorded; the
next run passes it in as input, typically from a schedule's literal or the
dashboard's launch form.

```ts
const standup = step("standup")
  .input(z.object({ session: sessionRef.optional() }))
  .do(async ({ input, agents }) => {
    const session = await agents.session(assistant, input.session ? { session: input.session } : {});
    const { text } = await session.generate("What changed since we last spoke?");
    return { summary: text, session: session.ref };
  });
```

Within one step, replay already returns the same session at the same call
position; this pattern is only for crossing a run boundary.

## A monitor that launches

A monitor's handler may return a locked node. The monitor starts it, and the
run is attributed to the monitor. Return a childless lock of a named definition. A bare definition does not
launch work.

```ts
monitor("https://tracker.example.com/issues/latest")
  .every("10m")
  .do(async ({ response }) => {
    if (!response) return;
    return ship({}, { task: (await response.json()).title });
  });

const nightly = workflow("nightly", test({}));     // a workflow locks with {} too
monitor("https://status.example.com/api").every("5m").do(() => nightly({}));

monitor("content/**/*.md").do(({ change }) => {
  if (change.kind !== "files" || change.added.length === 0) return;
  return index({}, { paths: change.added.map((file) => file.path) });
});
```

Return `undefined` to do nothing this tick. HTTP monitors fire on any change
to the body; if the body carries a timestamp, read `response` and return
early when nothing you care about changed.

## A parallel fan-in

Independent work runs together; the parent receives every result by key.

```ts
const weekly = workflow(
  "weekly",
  publish.parallel({
    findings: reviewInWorktree({}, { base: "main" }),
    exitCode: test({}),
  })
);
```

`publish.input` declares `findings` and `exitCode`. Each child's output is
checked against its key when the module loads.

## A sandbox with a result

A sandbox handle belongs to the run that opened it. Return what the command produced, not the
handle.

```ts
const box = sandbox({ image: "docker.io/oven/bun:1-slim", mount: "." });

const test = step("test")
  .output(z.number())
  .do(async ({ sandboxes, stream }) => {
    const env = await sandboxes.start(box);
    const result = await env.exec(["bun", "test"]);
    stream.write(result.stdout);
    return result.exitCode;
  });
```

For a scratch environment with no repository, use the `files` form:
`sandbox({ files: { "check.sh": "…" } })` seeds `/workspace`.

## Anti-patterns

- **Returning a live handle.** A session object, a sandbox, or a worktree path
  as a step result. Return the ref, the output, or the branch.
- **Effects before an ask.** A commit, a message, a write that runs again on
  replay. Move it after the ask or into its own step.
- **Branching on live values around context calls.** `if (Date.now() % 2)
  await agents.session(...)` changes the call order between replays and
  breaks them. Branching on `input` is safe: it is recorded and identical on
  every replay, so returning early when a child reports success is fine.
- **Inventing session ids.** `{ session: { id: "review-main" } }` with an id
  nobody opened. Continue only a ref a step returned.
- **Passing `signal` to Marbles' own calls.** Agent turns, sandbox commands,
  and worktrees are already cancelled with the step.
- **Scheduling a tree.** `schedule(publish.parallel({ … }))`. Wrap it in
  `workflow(name, tree)` and schedule that.
- **Doing work in a workflow's `.do`.** Setup is not durable; it runs on every
  resume. Prepare and return the tree; the work goes in steps.
