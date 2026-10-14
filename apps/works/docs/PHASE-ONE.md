# Works phase one: the micro-app harness

Status: implemented on `feat/works` (`5571583` through `f929d35`), with the
verification and remaining gaps recorded in [Implementation status](#implementation-status).
Four open questions were decided during implementation and remain reversible; see
[Decisions taken during implementation](#decisions-taken-during-implementation).

Execution planning: [Phase-one technical specification](PHASE-ONE-TECHNICAL-SPEC.md)
defines proposed contracts, ownership, migrations, finite slices, and acceptance
gates. [Works context](CONTEXT.md) records the domain language used in that spec.

Mantra: keep everything super simple. Reuse the existing engines and contracts,
prove one small pattern at a time, and add only what the next feature needs.

## Goal

Establish the core Works shell and conventions for authoring, loading, and
running micro-app Modules. Deliver small features that can each be tested and
accepted independently. Docs will be the first library Module built against
these conventions in a separate feature after the foundation is ready.

Works owns the application harness. Modules supply functionality, views, and
editors. Artifacts hold the things users create, including versioned Module
source and releases. The shell must remain useful without a preinstalled
collection of core Modules.

## Current foundation

State after phase one, on `feat/works` at `f929d35`:

- Works starts Marbles as its required execution engine (`@foundry.sh/marbles/engine`)
  before it accepts saves or launches. Every documented action is an engine
  Execution Run on a named FIFO queue: `system` for saves, publish, import,
  settings, Access, power, Version selection, builds and Program lifetimes;
  `module/<id>/authoring` and `module/<id>/workflows` for chat turns and workflows.
- The Module workspace has a side chat. Agent turns run in the Module's one
  sandbox, produce reviewable proposals, and reach saved source only through the
  person's Draft and fenced save. Builds borrow the same sandbox.
- The rail has Home and Artifacts at the top, Modules and Settings at the bottom,
  and Module shortcuts in between. Modules has Catalog, Dashboard, Calls, Workflow
  Runs, Execution Runs and Artifact Saves tabs. Application Settings is unchanged.
- `foundry.module.json` parses as the legacy `foundry.module/1` or the strict
  `foundry.module-manifest/1`, which adds resource minimums, a network request,
  `persistence.files`, settings requests/defaults and `editors[]`. A committed JSON
  Schema assists authoring (`.vscode/settings.json` maps it to `foundry.module.json`).
  The starter still writes `foundry.module/1`.
- Each Module has one durable Installation with its Grants. Catalog detail has an
  **Access & settings** tab: Access approves and revokes Grants, and the Module
  settings form edits limits and preferences. A header switch turns a Module on or off.
- Installed Modules use `~/.foundry/modules/<dir>/{source,artifact,data}`, with
  blob bytes in files under `.library/blobs`. Released apps mount only `artifact/`
  (read-only) and `data/` (read-write), and get network only through an approved
  Grant.
- Works supplies host Capabilities over the Module Gateway: `works.system.theme`,
  `works.editors.binding`, `works.artifacts.{read,save,create,watch,list}` and
  `works.execution.{start,watch,cancel}`.
- The Artifacts destination shows a typed grid with thumbnails. It opens Artifacts
  through an editor resolver and can create a Markdown file. The core fixture
  `apps/works/modules/markdown-fixture` edits Markdown File Artifacts through
  host-owned bindings and runs the registered example workflows.

Source anchors: [Works README](../README.md),
[composition](../src/main/works.ts),
[shell](../src/app/layout/shell.tsx),
[Module workspace](../src/app/modules/module-workspace.tsx),
[Module manifest](../../../packages/modules/src/manifest.ts), and
[Artifact registry](../../../packages/artifacts/src/registry.ts).

## Phase-one requirements

### Chat alongside the Module workspace

Add a side chat that can work on the selected Module's source. Users can ask
an agent to create or change the micro-app, inspect its edits, and build and
preview the result using the existing workspace flow.

Coding and builds use the same authoring/build sandbox with internet access, including
dependency installation. With `bash`, the agent can reach external hosts. Host mounts,
host commands and credentials remain absent; provider keys and model API calls stay on
the host. One sandbox per Module is reused by turns and builds. While the Module
is on, its sandbox stays on even when idle, including when it supports other
Modules. Chat turns and builds run in parallel, using snapshot isolation supplied
by underlying technology owned by the user. Works does not introduce a build/chat
serialization feature. Memory allocation may be
set per Module; omitted values use a host default tuned through experiments.

Implementation note: the user-owned snapshot layer does not exist yet. Turns and
builds run in parallel in one shared VM. A separate `bun` guest user runs the
agent's tools. Builds run as root in a root-only `0700` `/builds` scratch
directory, and each turn reseeds `/workspace`. They still share the kernel, `/tmp`,
network and CPU. This is a mitigation, not snapshot isolation; see
[Known gaps](#known-gaps-and-deferred-items).

The first slice supports independent Module conversations through their named
queues; it imposes no global one-Module restriction. Each conversation exposes
progress, failures and cancellation, with per-Module concurrency settings. Agent edits must participate in
the workspace's source/diff/save flow and handle concurrent manual edits
without silently overwriting them. Agentic coding should have a defined Module
boundary so it can become a loadable core tool without forcing a general plugin
framework into the first chat feature.

### Permanent shell navigation

Use two permanent destinations at the top: **Home** and **Artifacts**. Use two
at the bottom: **Modules** and **Settings**. Preserve the middle band for
individual loaded Module shortcuts.

Home is the directory/landing destination. Modules manages the Module library;
Settings manages the Works application and stays as it is now.

### Modules catalog, usage, and auditing

Keep the catalog inside the permanent Modules destination and add these tabs:

- **Catalog:** the Module library and its existing management/opening paths.
- **Dashboard:** usage and activity, with the time range and Module scope clear.
  Show call/run counts and available consumption metrics; missing token or cost
  measurements remain unknown rather than becoming zero or estimated facts.
- **Calls:** individual engine-observed calls, with status, timing, and available
  usage. Preserve links to the originating Module and run.
- **Workflow Runs:** workflow executions and their status and related activity.
- **Execution Runs:** all execution runs owned by Works, including agentic work
  and Module-initiated work, with progress and terminal outcomes. This tab shows
  durable Execution Run entities. Each Agent Session generate/stream call has
  recorded start, progress and terminal outcome, correlated to its Module and
  Agent Session. Execution Runs are the engine's durable runs on named queues;
  Works keeps no wrapper record. Builds and Program lifetimes target this model, with current
  adapter gaps described in the technical spec. Program runs remain running
  until stop and become interrupted after a crash.
- **Artifact Saves:** committed Artifact saves across Works, including Module
  source/release saves and non-Module outputs, linked to Artifact/Content and
  originating execution when known. Failed save attempts appear as typed rows in
  Execution Runs, with an attempts filter, outside the committed-save listing.

Use Marbles engine observations and correlate Agents harness work within its
runs. The technical spec compares existing seams to identify integration work,
not to reopen engine selection. Correlate file/source commits and other execution
sources without inventing another workflow engine or merging unlike events.

Works owns one sandbox per Module, shared by agent turns and builds. A request
for a Module with a live sandbox routes there, rather than creating another VM.
Machine-wide live-sandbox/memory ceilings are fixed host defaults in phase one;
per-Module settings choose effective values below those ceilings. Numeric
limits, retention and performance budgets in the spec are recommendations to
experiment with, not approved fixed values or numeric acceptance gates. A Module that
is on keeps its sandbox on even when idle. Chat turns and builds run in parallel
against isolated source snapshots supplied below the application layer (not yet
available; see the implementation note under the chat requirement).
Phase one uses explicit resource allocations through the existing planned Module
settings. Autoscaling-specific minimum/maximum bounds, utilization/pressure
measurement and automatic adjustment belong together in
[phase two](PHASE-TWO.md#bounded-module-resource-autoscaling). They are not
phase-one requirements.

Start with local, read-only auditing. Use stable event/run identifiers and
Module correlation, show running/completed/failed/cancelled outcomes, and retain
enough history to inspect activity after restart. Define retention and snapshot
plus subscription behavior in this feature. Handle reconnects without duplicate
records or gaps hidden from the UI. Secrets must not appear in audit payloads;
raw prompts, arguments, and results need an explicit recording policy.

This activity foundation should support later remote execution and user-scoped
auditing. Remote servers, accounts, and RBAC are phase-two work.

### Module settings in phase one; global settings expansion deferred

Application/global Settings stays unchanged; its expansion is deferred.
Per-Module settings are part of phase one. Declare dot-notation keys and their
requests/defaults through `foundry.module.json`; host-owned Works state stores
user values by Module ID, validated and capped by host ceilings. Limits and
preferences are Module settings. Network, access beyond bindings and
host operations are Grants, shown and revocable in Access; settings never grant
authority.

Required settings cover resources, authoring limits, queue concurrency, sandbox
idle policy and editor preference; network, broader Artifact access and host
operations use declared Grant requests, with the open defaults recorded in
the technical spec. Provider secrets stay host-side and are not settings shared
with the sandbox. Decided during implementation; reversible: Module settings are
edited in Catalog detail beside Access, on its **Access & settings** tab. The
Access panel approves and revokes Grants separately, and the two share no code path.

### Artifact explorer and opening behavior

Provide a grid of created Artifacts with names, recognizable types, and
thumbnails or suitable fallback icons. It is an Artifact/file explorer within
the shared storage model, not an unrestricted host filesystem browser.

The general grid excludes Module Artifacts from its default listing. Module
Artifacts still resolve through the shared type system and open the appropriate
Module experience when addressed explicitly. This is a presentation filter,
not a second persistence model.

Resolve the Artifact type and relevant entry-file MIME to select an available
viewer/editor. Unknown or unsupported types must remain visible with an honest
fallback. An Artifact can contain multiple files; do not assume every grid item
is a single file or choose an arbitrary entry silently.

### Editor convention

Define how a loadable Module registers the Artifact types it can open and how
Works passes the selected Artifact, Content, and entry to it. Define how edits
return to versioned Artifact storage and how unsaved changes are handled.

Reuse the existing Pierre source editor where appropriate. Text, code, and
Markdown opening are intended use cases. Rich document editors such as Tiptap,
slides editors, and editor code from the other repository are later Module
features; phase one establishes their loading and persistence contract.

### Core Artifact API and reconciliation foundation

Artifact management is a core Works API responsibility alongside agentic work.
Expose approved scoped operations for creating, listing, reading, saving, and observing
Artifacts and their files through the Module bridge. Reuse Artifact identity,
Content versions, entry paths, and MIME metadata rather than introducing an
editor-specific persistence system. File Artifacts are first-class use cases;
an MD file must be creatable and editable without becoming a Module.

Establish an explicit base revision for edits from both people and agents.
File Artifacts and Module source save ready working Content in place with
last-read fences or per-file `expectedDigest`. Only explicit release/freeze
creates immutable snapshots/Versions. Engine runs record save
observations for both; latest host-bound origin on Content supports recovery
before another overwrite. File Artifacts use ArtifactFileSystem plus Workspaces,
with backing bytes in files and record JSON holding descriptors/metadata. The
current FS writes in place and checks the per-file digest at
[filesystem.ts:239](../../../packages/artifacts/src/node/filesystem.ts#L239) and
[filesystem.ts:504](../../../packages/artifacts/src/node/filesystem.ts#L504);
Workspaces checks `expectedDigest` at
[directory.ts:134](../../../packages/workspaces/src/directory.ts#L134).
A committed save with failed engine result persistence reports saved/evidence recovery
required and is reconciled at startup before that Artifact can save again.
Concurrent changes must be detected and reconciled or surfaced for resolution;
no actor may silently overwrite another actor's work. Distinguish a local draft,
a committed Content version, and an observed update. Include origin/run
correlation so agent changes remain explainable in the audit views.

Git, operation-based collaboration, and other reconciliation approaches remain
open options. Choose against actual source-code and document/file scenarios;
do not assume one merging strategy fits every Artifact type. Phase one proves
the local human/agent conflict contract and leaves an extension path for remote
participants; multi-user propagation belongs to phase two.

### Validated Module configuration

Formalize configuration for released output entry points, sandbox requirements,
and persistence. Extend the existing `foundry.module.json` convention unless a
specific incompatibility justifies a migration. `modules.config.json` was an
example name, not a requirement for a second configuration file.

The contract must describe:

- The runnable released program and named output views/entry points.
- Compatible sandbox runtime and declared resource requirements, including
  memory and storage. A 256 MB memory requirement is an example, not a universal
  default.
- Whether persistent storage is required, its scope and mount convention, and
  its lifecycle. A Module may need a private database/volume, shared Artifact
  persistence, both, or neither.
- Required and optional host capabilities, with versioned contracts.
- Per-Module dot-notation settings requests/defaults, with host-stored user values
  capped by host ceilings, for limits and preferences.
- Artifact access requests: binding-only by default; broader access and
  observation require scoped Grants approved/revoked in Access.
- Released app network access declared in `foundry.module.json`, moderated by
  approved Grants and revocable through the Modules Catalog Access panel.

Provide validation and a JSON Schema for authoring. Report invalid declarations
and unsupported runtime/resource requirements before launching. Requested
resources must be checked against what the sandbox can enforce; do not present
an unenforced limit as isolation. Module build tooling can vary within supported
runtime contracts; Works consumes validated runnable outputs rather than adding
a custom shell workflow for every project framework.

### Capabilities and the harness boundary

Use the existing Module Gateway to expose controlled host functionality,
including agentic workflows and shared Artifact access. Declare what a Module
requests separately from what the harness makes available and grants.

Released app network is whatever the approved Grant allows, not a blanket network-off
policy. Undeclared, denied or revoked access is unavailable. The current framework
hardcodes disabled network for released Programs at
[container-runtime.ts:145](../../../packages/modules/src/platform/container-runtime.ts#L145);
Grant-moderated access is new framework work. Decided during implementation;
reversible: the approved Grant becomes a sandbox destination allowlist at Program
start, and there is no host Gateway fetch proxy. Approved destinations are TLS
(HTTPS) only, and plain HTTP to an approved host is denied. Approving or revoking
network access stops and restarts the open app under the new policy.

`artifacts.access` defaults to files opened for or created by the Module;
broader list/read access is grantable through explicit scoped Grants. Creation
returns a binding so the Module can read/save the new entry. Use one Capability
per operation for clear authority, not because the schema forces that design.

Start with the capabilities needed by the first features. Test allowed, unavailable,
denied, and revoked access. The Modules Catalog detail Access panel provides approval
and revocation separately from the per-Module settings controls. Keep one durable
Installation per Module; matching Grants carry over to another Version when the
capability, capability version, and resolved constraints digest are unchanged. Agentic
work, workflows, and provider API calls execute on the host through approved
capabilities; Modules can request and observe that work without receiving provider keys.
Keep harness credentials outside Module source, released outputs, and sandbox storage. A
Module bringing its own credentials is an exceptional, separately designed path, not the
default or a reason to embed keys in released code. Incorporate the other project's
harness experience when supplied; its implementation is not a prerequisite for writing
this plan.

### Shared system state and the Module connection

Provide a host-owned shared system state, exposed as small declared slices over
the Module connection. A Module receives only the slices it is allowed to read,
with an initial snapshot and reactive updates. This is a connection contract,
not shared mutable memory or unrestricted access to the shell's React state.

Prove the pattern with appearance: expose the selected mode (`auto`, `light`,
or `dark`) and effective appearance (`light` or `dark`). When the harness follows
the OS, an OS appearance change updates the effective value in connected
Modules. An explicit harness preference remains authoritative. Modules choose
how to render the state; receiving it does not let them change global settings.

Keep system state reads separate from commands. A Module uses approved commands
to launch agentic work or its workflows and observes the resulting runs through
the bridge. Work must retain Module/run correlation for the auditing views.
Choose the smallest transport that fits the existing Gateway and sandbox
connection; the final bridge implementation remains an owning-feature decision.

Share only declared, approved non-secret variables at connection establishment
and through validated updates. Resolve sensitive values on the host when an
authorized operation needs them, rather than placing them in the shared state.
Do not pass arbitrary environment variables to a Module. Define reconnect,
unsubscribe, permission revocation, and runtime-stop behavior, including a fresh
snapshot after reconnect and removal of access when a grant is revoked.

Keep the contract versioned so a future authorized user-context slice can be
added without exposing the whole user/session object. User identity and RBAC
remain phase two; do not invent a local user system to implement theme sharing.

### Loadable core Modules

Establish a repository folder convention for core Module projects. Docs, slides,
and agentic coding are intended library categories, rather than permanent
special-case shell screens. Modules can be loaded when available; Works must not
require all of them to be preinstalled.

Core Module source projects live in `apps/works/modules/`, using the existing
composer and package loading path. Phase one proves this with an explicitly
loaded fixture, not a preinstalled rich editor. This source folder is separate
from installed user folders at `~/.foundry/modules/<moduleId>/`. Each has
`source/` for everything buildable, `artifact/` for the selected release output,
and `data/` for SQLite and its `-wal`, `-shm` and `.bak` companions. The Foundry
config is the Manifest at `source/foundry.module.json`; the agent edits it like
any other source file, with ordinary build/package conventions. It grants no
authority; host Access approves/revokes Grants.
Agent/build sandboxes receive only `source/`. The app mounts only `data/`
read-write and `artifact/` read-only as its Program, never source or config.
Selected output uses the Artifact FS layer; older releases remain in file-backed
storage for reselection. This replaces temporary runtime checkouts and requires
a selected-release projection.
Move existing `.data/` private files once with verified reopen, keeping originals
until success. The technical spec cites the current source-root and data layout.

The execution engine is a core, required part of Works. It starts before Works
accepts saves or launches; startup failure is reported as a Works startup failure.
All documented Works actions run through it. The named
`system` queue handles saves, publish, import, settings changes and adapted
build/Program work as an unbounded FIFO: unlimited means admission, not
concurrency. Requests are never rejected for queue capacity; saves to the same
Module stay in request order. Other FIFO queues, including Module authoring and
workflows, have separate Module-configurable concurrency and no length caps.
Sandbox ownership and machine ceilings still bound VMs. Verify engine-routed
saves add no noticeable editor delay. Decided during implementation; reversible:
there is no separate Works evidence log, because the engine run store covers every
documented action and result. Slice 8 found no such log to remove and added none.

## Feature sequence and acceptance

Each row is a separately reviewable feature. Split further when a row requires
multiple independent changes; do not deliver phase one as one large rewrite.

| Order | Feature | Acceptance boundary |
| --- | --- | --- |
| 1 | Module coding chat | A request edits one Module; edits appear in its existing diff flow; cancellation, errors, and manual-edit conflicts are visible; the result can be saved, built, and previewed. |
| 2 | Permanent navigation | Home/Artifacts occupy the top; Modules/Settings occupy the bottom; Module shortcuts and keyboard-accessible navigation still work. Ship the Artifact destination with a useful initial listing. |
| 3 | Configuration, Module settings and sandbox requirements | One versioned configuration contract validates outputs, runtime compatibility, resources, persistence, settings and capabilities; unsupported requirements fail clearly; declared-and-approved app network works and undeclared/denied/revoked network does not; existing Modules retain a defined compatibility path. |
| 4 | Shared system state | A Module receives an approved initial theme snapshot and live OS/harness updates; reconnect refreshes state; denied slices and host secrets are absent; closing or revoking the connection releases access. |
| 5 | Artifact explorer and resolver | Non-Module Artifacts appear in the grid; exact types and entry MIME select handlers; Module types resolve explicitly; unknown types and multi-file Artifacts have defined behavior. |
| 6 | Editor/loading contract and core folder | A small fixture Module can be loaded and open a supported Artifact through the declared interface; saves preserve Artifact version semantics; no rich editor is required to prove the contract. |
| 7 | Required host capabilities | The first real consumers use declared Gateway capabilities; approval scope, denial, Catalog Access-panel revocation, and persistent Artifact access are verified through the sandbox boundary. |
| 8 | Modules auditing | Catalog remains available beside Dashboard, Calls, Workflow Runs, Execution Runs, and Artifact Saves; real activity is correlated, live updates reconcile with retained history, and save failures cannot appear as successful commits. |
| 9 | Core Artifact API and reconciliation | A fixture Module creates, reads, edits, and observes a file Artifact through a scoped watch subscription with snapshot, reconnect and revocation handling; human and agent edits carry a base revision; stale writes preserve both edits or produce a recoverable conflict; committed saves appear in auditing. |

The chat feature may need a minimal agent capability and configuration support before
the broader conventions in later rows. Build only what the feature needs, then formalize
the shared contract. The later capability feature completes the Module-facing extension
path rather than postponing security for early chat. Capture the minimal execution and
commit observations with their first real producers; the auditing feature assembles
their views rather than requiring a later rewrite to discover missing activity. Global
Settings expansion remains deferred; Module settings is in phase one. Establish the
minimal Artifact edit/conflict contract with coding chat and the editor fixture; row 9
formalizes the shared API rather than postponing conflict handling until after editors
are built.

## Implementation checks in the owning features

The technical spec resolves the initial design choices; implementation verifies
these contracts before claiming acceptance:

- Home is the app landing directory. A host-folder browser is separate work.
- Implement the Marbles gaps in the spec, integrating Agents harness work and
  persisting Sessions and engine runs while reusing the Module sandbox.
- Agent edits become reviewable proposals; explicit acceptance changes the Draft
  and explicit fenced save commits it.
- Both Manifest formats, resource enforcement and persistent Installation files
  need compatibility and restart tests after the verified private-data move,
  preserving originals until success and excluding data from source build input.
  Module settings is required; it sits in Catalog detail beside Access (decided
  during implementation; reversible).
- Verify the Gateway theme stream and bounded browser relay, including selected
  mode, effective appearance, reconnect, revocation and native OS changes.
- Verify real engine observation coverage, retained history, redaction and
  correlation before assembling audit views.
- Prove editor selection, missing-editor fallback and package loading with the
  core fixture.
- Prove local human/agent stale-write recovery. Git remains an option to evaluate
  for remote collaboration, not a selected dependency or protocol.

Each feature stays within its acceptance boundary. These plans do not authorize
a broader redesign or migration outside that scope.

## Completion and next feature

Phase one is complete when the harness supports chat-driven Module authoring, the
permanent navigation, typed Artifact browsing/opening, validated sandbox/output
conventions, loading Modules with controlled host capabilities, reactive shared system
state, and the Modules usage/auditing views. Artifact management through the core API
and recoverable human/agent edit conflicts are also required. Application Settings stays
unchanged; per-Module settings is required and sits in Catalog detail beside Access.
Verify persistence across restart and real sandbox execution in addition to
unit and UI tests where the feature touches those boundaries.

**Docs/Markdown** is the first library Module release in [phase three](PHASE-THREE.md),
after the supporting conventions are ready. Select or port the rich editor in
that separate feature. [Phase two](PHASE-TWO.md) establishes remote collaboration;
it does not add remote/user implementation to phase one.

## Implementation status

Phase one was built on `feat/works` in the nine feature rows below. Seven review fix
waves followed (`4a52896`, `0f98968`, `9e84f6e`, `5bb9480`, `c067d2e`, `502537c`,
`f929d35`). They fixed defects and restructured code without moving a feature
boundary.

"Tests" means the default `bun run test` suites (Vitest; renderer suites under
happy-dom). "Native" means the opt-in journeys outside `test`: `test:electron`,
`test:module-build`, `test:module-runtime` and `test:module-native` (Electron 43
and Microsandbox VMs), and `test:real-app` (the built app, launched with a temporary
home and user-data directory). Two further journeys never run unless asked:
`test:appearance` changes the desktop's appearance and `test:authoring-live` calls a
real provider. At `f929d35`, `bun run validate` passed. `bun run test` passed 27/27
tasks, also with `--force`: Works 378 tests, artifacts 150, modules 285, marbles 427
and workflows 856. All four native journeys passed. Every run was on one Apple M4
Max machine, not in CI.

| Row | Feature | Commits | Tests | Native |
| --- | --- | --- | --- | --- |
| 1 | Module coding chat | `5571583`, `d6e961f` (engine, sandbox owner); `18a091d`, `fc7b27d` (chat) | Real engine with a scripted model and a fake sandbox: proposals, correlated runs, model-turn and denied tool-call observations, questions, cancel, deadline, stale refusal, restart recovery. Draft reconciliation matrix, `system` FIFO order and routed save latency. | `test:module-build` builds in the shared Module VM. `test:module-native` runs a scripted-model turn (real coding tools as the `bun` guest) and a build of the same Module at once in its one VM: the turn's tools run while the build installs, the guest cannot list, read or write `/builds`, the release equals saved source plus `bun.lock`, and the turn yields a proposal that accepts. |
| 2 | Permanent navigation | `e05f9a6` | Rail order, `aria-current`, arrow/Home/End keys, Catalog tab, initial Artifact listing. | The library smoke checks the rail order and the empty Artifacts state. |
| 3 | Configuration, settings and sandbox requirements | `ae89e7b`, `e76a5f4`, `3aabaf7`, `816b593` | Both Manifest formats and their rejections, schema freshness, settings resolution, preflight, ModuleStore conformance on a real JSON store, Grant carry-over and re-prompt, folder layout, `artifact/` projection, private-data move, mount guard, network Grant matrix. | A released app starts from `artifact/` through the mount guard. Network smoke: blocked before approval, `example.com` reached after it with other hosts blocked, blocked again after revoke and restart. `test:module-native`: `resources.cpus`/`memoryBytes` settings and Manifest minimums reach the authoring/build VM and released Program VMs (`nproc`, `MemTotal`); Drizzle rows survive a Version switch and the switch back under Electron's `node:sqlite` (`VACUUM INTO` backup checked); a guest-written `.data/` folder with a row only in its WAL moves into `data/` and reopens. |
| 4 | Shared system state | `a6cc3a3` | Theme persistence and first-run adoption, provider coalescing, proxy lifetimes, SDK transport over a real WebSocket, relay end to end with a real Bun Program, Gateway and proxy. | Theme smoke: initial state, explicit overrides, reconnect, revoke and re-approve, Program stop. The OS change is simulated through `nativeTheme.themeSource`. |
| 5 | Artifact explorer and resolver | `de88406` | Resolver precedence, entry choice, remembered editors, thumbnails, open dialogs. | `test:real-app` opens a new Markdown file through the resolver. |
| 6 | Editor contract and core folder | `43a593a` | File create/read/save/watch, retry and recovery through a real dispatcher and JSON store; the built fixture package against a real Program, Gateway and proxy. | Editor smoke. `test:real-app` saves through the fixture editor inside the Works renderer frame. |
| 7 | Required host capabilities | `1fd526a` | Workflow start, watch and cancel, runtime ownership, revocation, broader Artifact scope, one sandbox shared by a running chat turn and a build. | Workflows smoke: list, read, ticker, cancel, revoked start. |
| 8 | Modules auditing | `943f0a7` | Run coverage of every documented action, redaction scan of the run store, retention and gaps, crash durability with a dead owner process, audit tabs rendered from a real engine store. | `test:real-app`: a created Module appears live in Execution Runs and its record lands on disk. |
| 9 | Core Artifact API and reconciliation | `272126e` | Reconciliation journey: concurrent person and fixture saves, conflict, recovery-required block, frozen successor, revoke. Source save evidence recovery across processes. | `test:real-app`: import fixture, approve Access, create a Markdown file, save in the fixture editor, see it in Artifact Saves, quit cleanly. |

Still manual or unverified:

- A chat turn against a live provider. `test:authoring-live` runs one when a
  Gateway or Vercel key reaches the environment (for example through
  `bun run env:run`); without one it reports the skip, which is all it has done
  here. The Electron close dialog for unsaved edits was not driven.
- A real macOS appearance change with an approved theme app open.
  `test:appearance` toggles it through System Events and restores it, but macOS
  refused this machine's terminal Automation access (-1743), so it stopped before
  changing anything. The theme smoke still simulates the change through
  `nativeTheme.themeSource` and opens the View in a top-level window, not inside
  the renderer frame.
- Crash recovery across real concurrent processes. Tests simulate dead process IDs
  in one process.
- Thumbnails and multi-file open dialogs (happy-dom only), and workflow revocation
  by clicking Access in Electron (verified through the Access service).
- Numeric limits use the technical spec's recommendations as code defaults. No
  workload experiment tuned them; measured latencies and sizes are in the technical
  spec, section 11.

### Decisions taken during implementation

Each of these was decided during implementation; reversible.

- **Evidence log:** Works keeps no separate evidence log. The engine run store
  records every documented action and result with typed observations, retention,
  and crash recovery. Slice 8 found no existing log to remove.
- **Installation and Grants storage:** stored as small Module Artifact metadata
  through `createArtifactModuleStore` (`@foundry/modules/store/artifact`). Each
  change is one Artifact transaction on the manager that file saves use. The adapter
  passes the ModuleStore conformance suite.
- **Module settings UI:** Catalog detail, on the **Access & settings** tab, beside
  the Access panel. Settings edits never approve access.
- **App network enforcement:** the approved Grant becomes a sandbox destination
  allowlist at Program start. Destinations are TLS (HTTPS) only. Approving or
  revoking network access stops and restarts the open app. There is no host fetch
  proxy.

## Known gaps and deferred items

Open or deferred at `f929d35`, each with the reason recorded at the time:

- **No snapshot isolation between chat turns and builds.** Natively verified: each
  works on its own copy (the turn on a reseeded `/workspace`, the build on saved
  source copied into a root-only `0700` `/builds/<uuid>`), the guest user cannot
  reach `/builds`, scratch edits never reach the release, and neither waits for the
  other. That meets the rows' intent that concurrent work cannot change the other's
  input, at the application and file-permission layer only. It is not the rows'
  isolated snapshots from the underlying technology: both share one kernel, CPU,
  memory, the 256-process limit, `/tmp` and network, and the agent could read the
  build's process command lines from `/proc`. A guest runaway can starve or fail a
  build, and a kernel or root escalation reaches it. This waits on the user-owned
  snapshot layer.
- **Starter and template stay on `foundry.module/1`.** The strict format is opt-in,
  the JSON Schema is not shipped into Module workspaces, and the fixture is
  hand-packaged with `encodeModulePackage`. Switching touches template generation,
  the SDK pack and upgrade, outside row 9's boundary. Access shows each Version's
  "App data" persistence so a strict `none` default is visible.
- **Approved network destinations are TLS only.** Plain HTTP to an approved host is
  denied, failing closed. Plain TCP needs a sandbox network change.
- **Composed workspaces from template 12 or older** keep a server without the
  `/_module/theme` relay after upgrade. No upgrade rewrites authored server source,
  so those Programs fall back to CSS appearance.
- **A Version switch while the app is open** waits for the app to close; no app is
  force-closed.
- **A crashed `persistence.files: none` Program** leaves its disposable folder until
  the next start clears it. That data is disposable by contract, and a startup
  sweep would need the supervisor's confirmed-stop state.
- **Save cost:** each file-backed blob fsyncs its directory (+8 ms p50), and each File
  Artifact save rewrites `artifacts.json` twice (p50 34 ms). Neither feels slow;
  batch fsyncs or add a read-only apply transaction (an `@foundry/artifacts`
  change) if saves do. The extra fsync for the `.applied` note was not measured.
- **Agent Session files have no retention.** That includes the input text of the
  summarize workflow under `<engine>/sessions`. Section 9 of the spec keeps
  conversation persistence separate, and `SessionStore` has no delete seam;
  deferred to phase two.
- **Workflow outputs live in memory only.** A new runtime cannot address an
  earlier runtime's executions, so nothing can ask for a lost output; durable
  outputs belong with phase-two workflow work.
- **Broader Artifact scope is by exact Artifact type.** There are no folder or
  per-Artifact scopes and no scoped save; none is in a phase-one gate.
- **The Artifacts grid does not refresh live,** and there is no separate control
  to forget an editor choice; neither is in a phase-one gate.
- **The Source editor is not told "recovery required" at save time.** The next save
  is refused with that explanation.
- **A Module whose records are corrupt** is skipped by scans and reported, but it
  cannot be deleted through the store. That needs a store-level path, or a hand
  edit of `artifacts.json`.
- **Gateway calls per Program run are capped at 500** observations, then counted.
  Every record change is published whole to subscribers; raising the cap needs
  per-observation change events.
- **The authoring guest's read commands** assume GNU coreutils and findutils in the
  sandbox image (true for `oven/bun:1-slim`).
- **Marbles TUI test flake** (`dashboard-controls.test.tsx`, one empty frame) is
  still open. It was not reproduced in 88 targeted runs or two full forced runs, and
  no root cause is claimed.
- **Kept by decision:** the audit stream keeps its own lossless ordered queue
  instead of the coalescing `latest()` helper. `RouterContext` services stay
  optional so renderer tests supply only what they render. Run records from before
  fix wave 5 are not listed as saves, because that format never shipped.
