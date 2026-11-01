# Adversarial review of a change

`adversarial-review.ts` registers the `adversarial-review` workflow. The
repository's `.foundry/marbles/adversarial-review.ts` imports it, so it is
part of this checkout's own Marbles workspace, next to `review-worktree`.

It reviews one change in two axes and keeps their conclusions apart:

| Axis | Checks against | Skipped when |
| --- | --- | --- |
| Standards | The `AGENTS.md` and `CLAUDE.md` files governing the changed paths, plus the root `CONTRIBUTING.md`. With `architecture: true`, Spyglass reports for the packages the change touches. | The change is empty. |
| Spec | The text in `spec` and the file in `specFile`. | No spec is given; no model call is made. |

Each axis opens a fresh reviewer session, then a fresh challenger session
that tries to disprove that axis's findings by reading the cited code.
Neither axis sees the other's findings. Only findings the challenger marks
`confirmed` are counted; `rejected` and `unresolved` findings stay in the
output with the challenger's reason.

## Inputs

| Field | Default | Meaning |
| --- | --- | --- |
| `worktree` | `.` | An existing Git checkout, relative to the workspace root. |
| `base` | `main` | The fixed point. The review covers the merge base of `base` and `HEAD` onward. |
| `includeWorkingTree` | `true` | Also review staged, unstaged, and untracked changes. |
| `spec`, `specFile` | empty | The originating issue or spec. `specFile` must be inside the checkout. |
| `maxFindings` | `8` | Per axis, 1 to 20. |
| `architecture` | `false` | Run `spyglass scan`, `report`, and `check` first. |
| `spyglassState` | Spyglass's default | Spyglass state root, `~/.foundry/spyglass` unless set. |
| `reviewerProvider`, `challengerProvider` | engine default | `claude-code`, `codex`, or `pi`. Different harnesses give the challenge an independent model. |
| `timeoutMs` | `600000` | Limit for each reviewer or challenger turn. |

## Output and failures

The run returns the pinned `root`, `base`, `mergeBase`, `head`, changed
`files`, the `instructions` it found, and one conclusion per axis: its
`status` (`completed`, `incomplete`, `failed`, or `skipped`), `review` and `challenge`
stages with their provider, session id, and any error, the `findings` with
verdicts, the `confirmed` count, and what the reviewer `inspected` and left
`unchecked`. The top-level `status` is `complete`, or `incomplete` when one
axis failed or has unresolved findings.

- Invalid input fails the run before any model call: no checkout, a `base`
  that names no commit, unrelated histories, a spec file outside the
  checkout or unreadable, or a spec over 40,000 characters.
- A reviewer turn that fails or returns an unreadable reply fails that axis
  only. The other axis still reports. When both fail, the run fails.
- A failed challenge leaves every finding of that axis `unresolved` and marks
  the axis and overall result `incomplete`. Missing or duplicate verdicts
  also remain unresolved; duplicates never count as confirmation.
- A Spyglass failure is reported as `architecture.status: "failed"` and the
  Standards reviewer is told the evidence is unavailable.
- If HEAD, the index, the working tree, or untracked file contents or names
  change between capture and the end of the review, the run fails and its
  findings are discarded. Capture is also checked before and after reading evidence. Prompts ask agents not to edit; they do not enforce it.

The patch sent to each reviewer is cut at 40,000 characters, and says so;
reviewers read the rest with `git diff`. Spyglass scans the checkout with
your privileges, runs its `.foundry/spyglass/` configuration, and writes
only under its state root. A first scan of this repository takes about a
minute and a half; later scans reuse unchanged packages.

## Run it

From the repository root, without a model:

```sh
bun run marbles -- roll adversarial-review --dry-run --input '{"spec":"Describe the requirement here."}'
```

`--dry-run` hosts the workspace in this process, so this repository's
`.env.schema` must resolve (`AI_GATEWAY_API_KEY`). Agent turns are echoed and
answered with the smallest valid reply, so the result has no findings.

For a real review, an installed and logged-in Claude Code, Codex, or Pi CLI
performs the turns:

```sh
bun run marbles -- roll adversarial-review --input '{"base":"main","specFile":"docs/issue.md","architecture":true,"reviewerProvider":"claude-code","challengerProvider":"codex"}'
```

## Through MCP

Shared project MCP entries are not installed. To connect a chosen MCP host,
use `bun` with absolute paths to `apps/marbles/src/mcp/stdio.ts`, followed
by `--source` and the absolute path to `.foundry/marbles`. This is source-checkout
configuration, not a published server. Host loading and cwd behavior still
need verification.

Normal startup joins or starts the machine-level Marbles daemon and can
replace one running another version. Attaching the workspace loads its source,
environment configuration, and schedules; hosting continues after the client
disconnects. The MCP server exposes general Marbles operations, not just review.
Once connected from an MCP client:

1. `list_config` names `adversarial-review` and its input schema.
2. `dispatch_workflow` with `{"name":"adversarial-review","input":{...}}`
   returns a `runId`.
3. `get_run` with that `runId` returns `status`, then the `output` above,
   or the `error` of a failed run.

The `adversarial-review-standards`, `-spec`, and `-assemble` steps are
listed too. Launch the workflow: an axis run alone skips the check that
both axes saw the same unchanged checkout.
