---
title: Primitives
description: The resources supplied to steps and monitor handlers.
---

The CLI binds a `Primitives` object after configuration registration.

| Field | Use |
| --- | --- |
| `models` | Model access through `models.model(model, provider, options)`. |
| `executors` | Selected, detected harness references in preference order. May be empty for deterministic work. |
| `workspaces` | Directory catalogue access and Git helpers. |
| `workspace.root` | Canonical config directory, or working directory without a config. |
| `agents.session(spec, options)` | Open an agent conversation using the runtime session store. |
| `sessions` | Disk-backed session storage in normal CLI execution; in memory under `--dry`. |
| `state` | This workspace's state directory, or `undefined` under `--dry`. |
| `stream.write(value)` / `stream.pipe(source)` | Stream live output from the step: strings as text, other values as JSON data. The step's return value is still its result. |
| `feed.post(entry)` | Publish a result or milestone to the [feed](#feed). Only valid inside a running step. |
| `feed.ask(question)` | Pause the run on a question in the feed and resume with the answer. See [questions](#questions). |
| `log(...values)` | Log any values into the run's logs; `log.debug`, `log.warn`, and `log.error` pick a level. |

Underlying Foundry model, session, workflow, and Git objects remain directly
accessible. Step bodies can import ordinary TypeScript libraries.

## Feed

The feed collects articles worth reading on their own: finished results and
milestones. Progress and intermediate output belong in `log`.

```ts
import { step } from "@foundry/quirks";

step("weekly-report", async ({ feed, log }) => {
  const report = await buildReport();
  log("report built", { sections: report.sections.length });
  feed.post({
    key: "report",
    kind: "result",
    title: "Weekly report",
    body: `${report.markdown}\n\n![Trend](media/trend.png)`,
    media: ["out/trend.png"],
  });
  return report.summary;
});
```

| Field | Use |
| --- | --- |
| `key` | Names the entry within its step. Posting the same key again in the same run updates the entry, so retries do not duplicate it. A step can post several keys. |
| `kind` | `result` or `milestone`. |
| `title` | The entry's headline. |
| `body` | Markdown. Refer to attached media as `media/<file name>`. |
| `media` | Files copied into the entry. Relative paths resolve from `workspace.root`. |

Each entry is an Artifact in the shared store at `~/.foundry/artifacts`: an
`entry.md` file plus its media, with the workspace, run, and step recorded in its
metadata. Invalid entries and unreadable media throw from `feed.post`, failing
the step. The engine copies media just after the post, so keep the files until
the step returns. The dashboard's
Feed tab shows entries from every workspace, and `w` filters by workspace.

### Questions

`feed.ask` posts an input entry and pauses the run until someone answers it in
the dashboard's Feed tab. Other runs keep going meanwhile.

```ts
step("release", async ({ feed }) => {
  const answer = await feed.ask({
    key: "confirm",
    title: "Publish v2?",
    body: "The changelog and tag are ready.",
    choices: ["publish", "hold"],
  });
  if (answer === "hold") return "held";
  return publish();
});
```

With `choices` (up to nine), the answer is one of them; without, it is free text.
When the run resumes, the step body runs again from the start and `feed.ask`
returns the answer instead of pausing, so work before the question should be
safe to repeat.

Only the dashboard process that started the run can answer. `quirks once` and
other non-interactive runs cancel a run that asks. Quitting the dashboard marks
its open questions cancelled; the paused run cannot continue in a later process.
If the dashboard crashes instead, the next Quirks start cancels questions whose
process has exited.

## Workspaces

```ts
import { step } from "@foundry/quirks";

step("inventory", async ({ workspaces, workspace }) => {
  const directory = await workspaces.add({ path: workspace.root });
  const { files } = await directory.refresh();
  const git = workspaces.git(workspace.root);
  return { files: files.length, git: await git.status() };
});
```

`add` returns a directory with the directory and Git extensions. The catalogue
is in memory. Quirks persists monitor snapshots and execution state separately;
adding a directory does not give it another Quirks state scope.

## Model turns and harnesses

Use the `ai` SDK when a turn does not need a retained Quirks conversation:

```ts
import { step } from "@foundry/quirks";
import { generateText } from "ai";

step("summarize", async ({ models, executors, workspace }) => {
  const executor = executors[0];
  if (!executor) throw new Error("No execution harness is available");
  const { text } = await generateText({
    model: models.model(executor.model, executor.provider, {
      workingDirectory: workspace.root,
    }),
    prompt: "Summarize this repository in three sentences.",
  });
  return { text };
});
```

Declare `ai` as a direct dependency in a project importing it. Quirks detects
`claude` and `codex` on `PATH`, preferring Claude Code when both are present.
Detection does not verify authentication. `--harness` filters that set. Model
and session operations need an available executor; deterministic work does not.
Dry model operations also use the selected detected executor references.

See [session options](/quirks/reference/factories#session-options) for retained conversations.

## Git and temporary worktrees

`workspaces.git(root)` returns a `Git` object rooted at the supplied directory.
`status()` returns one of:

- `{ kind: "none" }` when there is no Git working tree;
- `{ kind: "unavailable", reason }` when Git state cannot be read;
- `{ kind: "repository", branch, detached, paths }` for a repository.

Each changed path includes `path`, `staged`, `unstaged`, and `untracked`.

```ts
import { step } from "@foundry/quirks";

step("review-checkout", async ({ workspaces, workspace }) =>
  workspaces.git(workspace.root).withWorktree({ base: "main" }, async (worktree) => ({
    status: await worktree.status(),
  })),
);
```

`withWorktree({ base, branch?, home? }, body)` creates a checkout, runs the
callback, and attempts removal in `finally`. It defaults to the system temporary
directory and a detached checkout. Supplying `branch` creates a branch that is
not automatically removed with the worktree.

A `Worktree` supports its parent Git operations. It separates the checkout but
does not sandbox the callback or harness. Runtime-provided Git commands use echo
substitution under `--dry`; reads and temporary directory creation can still
occur. See [safety and limits](/quirks/safety-and-limits).
