# Marbles: findings from guides and recipes

Maintainer note, excluded from the Blume site. Writing a guide or recipe
against the real library is how we learn where the API runs out. Each
finding records the page that found it, what the page does instead today,
and a proposal. When a finding lands, update the page that worked around it
and delete the entry here. Where a proposal here and
[`_api-alt.md`](./_api-alt.md) disagree, settle it in `_api-alt.md`, which
wins.

The technical design that turns these into changes, with files, types,
tests, and an order, is [`_next-api.md`](./_next-api.md). Where it corrects
an entry below, it says so; it wins until the entry is updated.

Each entry has the same parts: **Found by**, **Today**, **The page does
instead**, **Proposal**, and **Open**. A finding that came from use rather
than a page says what changed or what the rule is in place of **The page
does instead**.

## 5. Memory an automation keeps between runs

**Found by** the Persistent Reviewer and Design Sync recipes.

**Today.** Nothing in the context reads back what an earlier run kept.
Artifacts can be written but not read, and session references must be
passed back by hand.

**The page does instead.** The persistent reviewer writes its session
reference to `.marbles/<name>.json` in the workspace. Design Sync commits
its last palette to the repository and reads it back. Both are the step's
own file I/O, so both happen under `--dry-run` too.

**Proposal.** A read for the latest version of a declared artifact,
`artifacts.latest(def)`, which covers both: the reviewer keeps its reference
in an artifact, Design Sync keeps its last proposed palette. Dry runs read
it and do not write.

**Open.** Whether the latest version is per workspace or global to the
artifact store, and whether a session reference belongs in an artifact at
all or in a smaller keyed store.

## 6. Command steps: `step(name).exec(template)`

**Found by** an API proposal, 2026-10-09. The nearest pages are the Software
Factory, whose `test` step starts a sandbox to run one command, and Design
Sync, which shells out to `git rev-parse` from a body.

**Today.** A step's work is always a `.do(fn)` body. Running one command
means a body that starts a sandbox or calls `node:child_process`, then
shapes the result by hand.

**Proposal.** `.exec(template)` as a terminal call beside `.do`. The input
schema names the values; `$name` placeholders in the template take them:

```ts
step("install")
  .input(z.object({ pkg: z.string() }))
  .exec("npm i $pkg");
```

```sh
marbles roll install --input '{"pkg":"zod"}'
```

The template is a plain string with `$name`, not `${name}`: a template
literal would be evaluated when the module loads, before any input exists.

- **No shell.** The template is split into arguments when the module loads,
  honouring quotes. Each placeholder fills exactly one argument and is never
  split again or read by a shell, so `{"pkg":"zod; rm -rf ~"}` is one odd
  package name, not a second command. An array value fills one argument per
  element: `.input(z.object({ pkgs: z.array(z.string()) })).exec("npm i $pkgs")`.
  A pipe or redirect has to be written as an explicit `sh -c '…'`.
- **Checked when the module loads.** Every placeholder must name a key of
  the input schema, and the program, the first word, must be literal.
- **Wired like everything else.** The command runs in the step's working
  directory, writes to the step's stream, and is killed by its `signal`.
  `--dry-run` echoes it and returns exit 0 with empty output, as sandbox
  commands do. `{ sandbox: box }` runs it in a sandbox instead.
- **A typed result.** The output is `{ exitCode, stdout, stderr }`. A
  non-zero exit fails the step; `{ check: false }` returns the exit code
  instead, which is what the factory's `test` wants:
  `step().exec("bun test", { sandbox: box, check: false })`.
- **A function for computed arguments.** `.exec(({ input }) => ["npm", "i", ...input.pkgs])`
  returns argv directly when a template is not enough.

**Open.**

- Builder order. The first sketch was `step(name).exec(template).input(schema)`.
  Today `.do` is terminal and `.input` comes before it; `.exec` should
  probably follow the same rule, so the schema is known when the
  placeholders are checked.
- Whether a step built with `.exec` can take children, and whether their
  results can fill placeholders by key, as they fill a body's `input`.
- A context-level `exec` for bodies, under the same rules, so Design Sync's
  `git rev-parse` stops bypassing dry runs and cwd plumbing.

## 7. Pass-through to the packages underneath

**Found by** using Marbles for real, 2026-10-09: structured output from an
agent turn was not possible, and the investigation that followed.

**The rule.** Marbles fills in what it owns: the working directory,
cancellation, the step's stream, dry-run echo, replay, and run identity.
Everything else passes through to the package underneath. A default is an
argument filled in, not an option removed. Concretely, each wrapper takes
the underlying options type minus the keys Marbles owns, and returns the
underlying result plus Marbles' own fields. Today most wrappers do the
opposite: they declare a small shape of their own and copy a few fields
across.

Structured output came first and has landed; the other sections are the
same problem in the other context keys. Paths are relative to the repository root.

### 7.1 Agents: structured output and model settings

Landed 2026-10-10 ([`_next-api.md`](./_next-api.md), Part B). Still open:
`tools` and `mcp` on `agent()`, which stay with the `AgentSpec` fields
`_api-alt.md` lists as unwired.

### 7.2 Sandboxes

`sandboxes.start` returns `{ exec(argv), close, id }`
(`apps/marbles/src/lib/types.ts:181-185`) over a `Container` that has much
more (`packages/sandbox/src/container/facets.ts:42-50`).

- **Facets hidden.** `files`, `processes` (spawn with stdin and streams),
  `shell`, `ports`, `services`, `volumes` are unreachable
  (`apps/marbles/src/lib/managers/sandboxes.ts:107-125`).
- **Exec options dropped.** No options argument: `cwd`, `environment`, and
  `user` are lost, and the string (shell) command form is refused. Output is
  not written to the step's stream either, which is a default Marbles owns
  and does not fill.
- **Spec narrowed.** `labels`, `ports`, `publicEnvironment`, `detached`, and
  `resources.pids` are dropped (`sandboxes.ts:72-104`). One mount, always
  read-write at `/workspace` with id `workspace`, and `workdir` fixed there
  (`sandboxes.ts:88-102`). Files are strings only and cannot be combined with
  a mount (`types.ts:62-83`).
- **Registry missing.** `list`, `remove`, `restart`, `sweep`.
- Marbles' `Sandbox` reuses the package's type name for a smaller shape.

**Proposal.** Return the container with Marbles' defaults applied (signal,
stream, dry-run echo), take the package's exec options, and take the
package's spec with `/workspace` and the mount source as defaults rather
than constants. The allowed mount roots stay: they are a boundary, not a
narrowing.

### 7.3 Workspaces

`git` is passed through whole by a proxy; the workspace itself is not.

- `files()` returns paths and drops kind, extension, and metadata
  (`apps/marbles/src/lib/managers/workspaces.ts:97-100`).
- `read`, `save`, `createFile`, `entries`, `refresh`, `summary`, `scan`,
  `id`, and `source` are hidden (`workspaces.ts:90-112`), and the workspace
  system's `on("change")`, `list`, `open`, and `close` are unreachable from a
  step (`workspaces.ts:163-165`).
- The worktree-defaults bug landed 2026-10-10 (`_next-api.md`, C.1).

**Proposal.** Return the package's `Workspace` with `git` decorated.

### 7.4 Artifacts

The context has `create` and `write` only; the manager underneath is held
as `Pick<ArtifactOperations, "create" | "get" | "revise">`
(`apps/marbles/src/lib/managers/artifacts.ts:26`).

- **No reads.** `get`, `list`, versions, `readFile`, `readRoot`: nothing
  written can be read back. This is finding 5's root cause.
- **Results stripped.** `ArtifactVersion` is `{ artifactId, contentId, id }`
  (`types.ts:194-199`): digest, state, tag, metadata, and timestamps are
  dropped.
- **Inputs narrowed.** Files are `string | Uint8Array` (no streaming
  source, blob reuse, or explicit MIME); `write` always replaces the whole
  tree (`artifacts.ts:112`); `create` drops `metadata` and `freeze`;
  `tag`, `freeze`, `fork`, `archive`, and transactions are unreachable.
- **No provenance.** Content metadata has `runId` and `sessionId`; neither
  is set, though the run id is at hand.
- The replay bug in the scoped `create` landed 2026-10-10
  (`_next-api.md`, C.2).

**Proposal.** Pass the manager's operations through with the workspace
identity and replay applied, and record run and session provenance by
default.

### 7.5 Steps and workflows

`.config({ retry, timeout })` and `bail` landed 2026-10-10
([`_next-api.md`](./_next-api.md), E.4). Still open: hooks, `skip`, an
author-side `waitIfPaused`, and structured log fields, which need a form
that does not overload `log(...values)`.

### 7.6 Skills

- Bundle files are read as UTF-8, so binary files in a skill are corrupted
  (`apps/marbles/src/lib/managers/skills.ts:43`).
- A skill defined in code cannot be added; `SkillOp` is only `load`, `add`,
  `pick` (`types.ts:24-28`).
- In a sandbox session, skill instructions are pasted into the system
  prompt and the skill's files, description, and registry tools are dropped
  (`apps/marbles/src/lib/managers/agents.ts:343-348`). Local sessions use the
  registry.

**Proposal.** Read bundle files as bytes, accept `Skill` objects in a set,
and give sandbox sessions the same registry tools local sessions get.

## 9. A roll cancelled at an ask is not saved

**Found by** use, 2026-10-10, while landing `_next-api.md` C.3. Not yet
investigated; it may predate C.3.

**Reproduction.** A workspace with `step("asks").do(({ ask }) =>
ask.question({ title: "Name?" }))` and a state dir. `marbles roll asks
--state <dir>` prints, before its one-line cancellation:

```text
[state] run rn-… not saved: InconsistentStoreSnapshotError: Run rn-… status suspended conflicts with terminal frame cancelled
```

twice. The run is cancelled at the ask as intended, but its record is not
written, so `status` and the dashboard may not show it.

**Proposal.** Find where the engine saves a run cancelled while suspended
(the run row says `suspended`, its frame says `cancelled`), and settle the
run's status before the save.

