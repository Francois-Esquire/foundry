# Works phase one technical specification

Status: implemented on `feat/works` (`5571583` through `f929d35`). Feature commits,
verification and remaining gaps are in
[PHASE-ONE.md, Implementation status](PHASE-ONE.md#implementation-status). Numeric
values remain experimental recommendations, adopted unchanged as code defaults;
section 11 records what was measured. Decisions marked "decided during
implementation; reversible" replace this document's former OPEN and CONFIRM markers.
Baseline: `feat/works`, product-plan commit `4edb9a9`. This document implements
[Phase-one requirements](PHASE-ONE.md) as a sequence of finite features.
File and line citations in sections 2 to 10 describe that baseline tree, not the
current code. The gap tables are the pre-implementation analysis. Where the built
code differs from this text, an "Implemented" note says so. [CONTEXT.md](CONTEXT.md) supplies
Works vocabulary and links to the canonical framework language.

## 1. Outcome and decisions

Deliver chat-assisted Module authoring first, then the shell destinations, validated
configuration, shared theme state, Artifact browsing/editing, approved host execution,
and Modules auditing. Application Settings remains unchanged. Per-Module settings are in
phase one; application/global Settings stays unchanged and its expansion is deferred.
Rich editors, remote servers, users, RBAC, and multi-user synchronization remain later
work. Home is the existing app landing directory.

Decisions for this revision:

- File Artifacts and Module source save ready working Content in place. Only an
  explicit release/freeze creates a Version or immutable snapshot.
- Engine Execution Runs supply save history for both files and Module source.
  Decided during implementation; reversible: there is no separate Works evidence
  log, because the engine covers these actions durably (section 9).
  Latest host-bound save origin commits with the files; failed engine result write
  reports "saved, evidence recovery required" and is reconciled before another save.
- Product files use ArtifactFileSystem and Workspaces with fenced in-place saves;
  records and file-backed bytes are separate, with one shared Artifact manager.
- One durable Installation per Module retains matching Grants across Versions.
  Decided during implementation; reversible: Installation and Grants are stored
  in Module Artifact metadata.
- One sandbox per Module is reused by chat turns and builds, with internet.
  Provider keys/model calls stay host-side. While the Module is on, its sandbox
  stays on even when idle, preserving services used by other Modules. Chat turns
  and builds run in parallel; underlying technology is to provide snapshot
  isolation, with the mechanism owned by the user, not an application scheduling
  feature. That layer does not exist yet; section 10 describes the mitigation in
  place. Memory allocation is optional/configurable with experimental defaults.
  App network authority is fixed by the Grant contract. Decided during
  implementation; reversible: it is enforced as a sandbox destination allowlist
  (section 10).
- Per-Module settings use validated dot-notation keys, Manifest requests/defaults,
  host-stored user values and host ceilings; global settings expansion is deferred.
- Phase one uses explicit resource allocations. Phase two owns the complete
  autoscaling feature: bounds, resource measurements, automatic adjustment and
  safe standby. Phase three consumes it. Active Modules stay available while idle.
- Theme includes selected mode and effective appearance, initially and reactively.
- Everything Works documents runs through the execution engine as an Execution
  Run, including Agent Session generate/stream work. Works keeps no wrapper Run.
  Builds and Program lifetimes target engine runs; current adapter gaps are in
  section 3. Marbles is the required execution engine; Agents supplies conversation/
  coding harness functionality within engine runs, not an alternative engine.
- The execution engine is core and required. Start it before accepting saves or
  launches; an engine start failure is a Works startup failure, not an optional
  degraded mode. All documented work depends on it.
- All runs use named FIFO engine queues. `system` has no length limit and never
  rejects requests for capacity; unlimited means admission, not concurrency.
  Authoring and Module workflow queues have independent concurrency settings. Sandbox
  reuse and machine ceilings bound VM count separately from queue concurrency.
- Modules start host-registered workflows; no Manifest workflow language.
- Core projects live in `modules/`; existing user Module workspaces
  use the per-Module layout in section 6 under `~/.foundry/modules/<moduleId>/`.

Phase one detects local human/agent conflicts. It does not select Git, CRDTs, OT,
or a remote collaboration protocol.

## 2. Framework baseline and ownership

| Existing code | Verified behavior | Phase-one responsibility |
| --- | --- | --- |
| [Module projects](../../../packages/modules/src/projects.ts) | `ModuleSourceBinding` fences source saves by Artifact, Content, and `updatedAt`; ready Content is written in place, frozen Content revised. | Reuse the binding and save path; add origin attribution without changing Version eligibility. |
| [Local library](../src/main/modules/local-library.ts) | Materializes saved source, auto-saves disk edits when bindings match, preserves files when disk and saved source both changed. | Materialize buildable files under `source/`; include disk synchronization in conflict and save evidence. |
| [Artifact transactions](../../../packages/artifacts/src/transaction.ts) | `WriteFence` checks Content and time; `updatedAt` increases even within one millisecond; ready Content supports in-place writes. | Use existing fences, not fingerprints or a second revision identity. |
| [Library](../src/main/modules/library.ts) | Source editing, import, build/publish, frozen tagged outputs, retained manifests; validation currently uses an empty capability catalog. | Supply actual provider catalog; preserve existing package and publish semantics. |
| [Build runtime](../src/main/modules/builds/runtime.ts) | Today builds get disposable VMs with unrestricted network, 2 GiB memory, and `bun run typecheck` before build; Marbles creates coding VMs separately. | Use one live sandbox per Module for authoring/build with unrestricted network; keep it on while the Module is on; chat/build work runs in parallel using underlying snapshot isolation; memory defaults are experimental. |
| [Released runtime](../src/main/modules/runtime/runtime.ts) | One process-shared in-memory ModuleStore; temporary Installations, Module-keyed private data mapping, one writer per Module. | Persist Installations; move private data into the Module folder with verified recovery. |
| [Controller](../src/main/modules/runtime/controller.ts), [proxy](../src/main/modules/runtime/proxy.ts) | Controller mints random view origins; proxy restricts requests and currently uses short request lifetimes. | Preserve origin/CSP controls; explicitly support the bounded theme relay. |
| [Gateway dispatcher](../../../packages/modules/src/gateway/runtime-dispatcher.ts) | Checks Principal, Grants, and provider-resolved digest; invocation context contains raw requested constraints. | Providers resolve authority from host state; raw constraints are not authorization facts. |
| [Theme](../src/app/theme/theme.tsx), [window](../src/main/window.ts) | Renderer persists mode and follows OS; main uses native theme for initial background. | Main owns shared mode and native theme; shell controls keep their existing UI. |
| [Marbles Engine](../../marbles/src/lib/engine.ts), [coding session](../../marbles/src/lib/sandbox/session.ts) | Hardcoded concurrency one; coding path lacks model observation; no public lifecycle subscription or dispatch-time record. | Use Marbles as the engine; implement the gaps in section 3 with Agents harness integration. |

Source-size checks currently live at the RPC boundary: the per-file text limit
counts UTF-16 code units, while aggregate size counts UTF-8 bytes. The library
itself does not enforce those limits. Apply the same checks to agent and disk
source admission, with their units named, rather than trusting bypassing callers.

The core domain is safe Module authoring and Artifact-based reuse. Works owns
Draft reconciliation, editor bindings, local policy, navigation, and evidence
projections. Modules owns identity, Version resolution, Installations, Grants,
and Gateway admission. Artifacts owns storage transactions, Content and fences.
Marbles/Agents/Models owns workflow and conversation execution and observations.
The Works execution adapter translates these models and exposes only the facts
the UI needs; it does not copy engine queues or Session lifecycle logic.

### Records, backing bytes, and editable files

Proposed Works composition uses these existing interfaces, not a new file store:

1. `JsonArtifactStore` owns Artifact/Content identities, trees, digests, metadata
   and blob references at `~/.foundry/modules/.library/artifacts.json`. Keep this
   existing record path, but not the earlier assumption that file bytes live in
   it. Today Works constructs that store in
   [local-library.ts:78](../src/main/modules/local-library.ts#L78).
2. One `ArtifactManager` owns transactions and application, injected into
   library, runtime, release materialization and file providers. Implemented:
   `modulePersistence(store)` builds it once per store. Manager calls made inside an
   open `transaction` join it, so the separate `ModuleArtifacts` subclass was
   deleted. Extend the existing composition
   at [artifact-store.ts:18](../src/main/modules/artifact-store.ts#L18) with
   `files: blobFiles("~/.foundry/modules/.library/blobs")` (resolve the home path,
   not a literal tilde). Backing blob files hold bytes independently of editable
   directories; see [blobs.ts:10](../../../packages/artifacts/src/node/blobs.ts#L10)
   and [blob-repository.ts:270](../../../packages/artifacts/src/blob-repository.ts#L270).
3. `artifactFileSystem({artifacts: sharedManager, root})` materializes one directory
   per Artifact under proposed `~/.foundry/artifacts/`. The FS resolves `{artifactId}`,
   applies committed tree changes, and polls disk edits back through fenced
   Artifact writes: [filesystem.ts:75](../../../packages/artifacts/src/node/filesystem.ts#L75),
   [filesystem.ts:213](../../../packages/artifacts/src/node/filesystem.ts#L213),
   [filesystem.ts:279](../../../packages/artifacts/src/node/filesystem.ts#L279).
   Module source materializes under its Module folder's `source/`, using the
   layout and Manifest contract in section 6.
   Selected release outputs use the Module `artifact/` projection described in
   section 6. FS currently binds all manager commits at
   [filesystem.ts:213](../../../packages/artifacts/src/node/filesystem.ts#L213);
   the owning feature adds selective product-file application so Module source/
   outputs are not exposed as a second editable workspace. The Module release
   projection is read-only and selected-Version-aware, not a writable FS mirror.
4. Compose `WorkspaceSystem.extend(directory({filesystem: artifactFS}))` for
   product File Artifacts and load `{artifactId}` references. Directory accepts a
   supplied FS at [directory.ts:311](../../../packages/workspaces/src/directory.ts#L311);
   WorkspaceSystem owns live Workspace instances at
   [workspace-system.ts:35](../../../packages/workspaces/src/workspace-system.ts#L35).
   Workspaces edits use the read snapshot's `expectedDigest` and the FS checks it
   again before `write`: [directory.ts:134](../../../packages/workspaces/src/directory.ts#L134),
   [filesystem.ts:504](../../../packages/artifacts/src/node/filesystem.ts#L504).

Records contain identity/metadata/tree descriptors, not newly published payload
bytes. Current JSON encoding embeds byte arrays as base64 and rewrites all records
on commit: [json-store.ts:84](../../../packages/artifacts/src/node/json-store.ts#L84),
[json-store.ts:195](../../../packages/artifacts/src/node/json-store.ts#L195).
The user's reported roughly 2.4 MB library is context, not a measurement made by
this spec. Existing inline-byte records remain readable as-is; the reader supports
both bytes and backing paths at
[blob-repository.ts:55](../../../packages/artifacts/src/blob-repository.ts#L55).
Enabling `files` does not relocate existing/deduplicated inline blobs or shrink
JSON. Phase one is fresh development: no legacy-byte migration project or
compatibility acceptance fixture is required. Keep current reads functional,
without claiming that enabling file backing has moved existing inline bytes.
New unique payloads must be file-backed.
`maxFileBytes` is a rejection limit, not a routing threshold
([blob-repository.ts:307](../../../packages/artifacts/src/blob-repository.ts#L307)).
Backups cover record JSON and referenced blobs coherently; editable directories
may contain pending disk edits, so preserve those too before recovery overwrites
anything. Close WorkspaceSystem and ArtifactFileSystem at host shutdown.

Decided during implementation; reversible: complete the Artifact-backed
ModuleStore with Installation and Grants as small Module Artifact metadata,
sharing the file-save transaction (`createArtifactModuleStore`).
This uses the existing metadata transaction scope, not another identity store.
Product browsing still filters Module MIME only at the presentation layer.

Give the Marbles feed a separate ArtifactManager/store; its feed
must not enter product storage. Agent Sessions and execution state stay separate
from product records whichever execution path is chosen.

## 3. Chat-first authoring contract

Add a side chat to the existing Module workspace. The first feature supports
independent Module conversations, built-in network-model coding, progress, questions,
approvals, failure, cancellation, diff review, and the existing save/build/preview
flow. Start experiments with one active turn per Module; that is a recommended
queue setting, not a global restriction or an approved fixed numeric ceiling.
Provider credentials resolve from the host vault at execution time.

An authoring conversation retains its Agent Session and Module identities.
Each Agent Session `generate` or `stream` call runs inside a durable Execution
Run. Persist its start before effects, progress and terminal outcome, correlated
to the Module and Agent Session. A conversation is not the execution record.
The renderer owns the Draft, its `ModuleSourceBinding` and source files,
preserving existing localStorage persistence. Draft behavior owns per-file
proposal reconciliation and atomic application. Implemented: the Draft is one
record behind one update path (`useModuleEditor`). Reconciliation is a pure,
synchronous function over the Draft read in the same tick the accept response is
applied, so typing cannot land between that read and the write. The planned local
edit counter never changed an outcome and was removed. Main owns turn execution,
saved-binding checks, and persisted captured
snapshots/proposals in Works authoring state, separate from redacted evidence.
Restart restores a proposal against its captured files, not renderer state from the
previous renderer process. Recovered scratch changes are offered only if they
were actually captured; a crashed turn does not promise recovery of VM files.

1. Send the Draft snapshot and source binding to main at turn start; persist the
   snapshot with the turn identity before effects.
2. Seed the shared authoring/build sandbox from it. Agent tools change scratch files; they do
   not save the library or write the user's workspace directly.
3. Validate returned paths, Manifest and size, then persist an Edit proposal
   against the captured files. Recovered interrupted proposals retain their status.
4. On accept, main rechecks the saved binding. If it moved, refuse acceptance,
   retain the proposal and Draft, and report "saved source changed" with an explicit
   compare/reopen/resolution path; do not apply files or replace the base silently.
   Otherwise return the proposal and its base. The renderer reconciles each path,
   treating an absent file as a value:
   if Draft equals base, use proposal; if proposal equals base, keep Draft;
   if Draft equals proposal, keep that value; otherwise mark a whole-file conflict.
   Disjoint edits accept cleanly; conflicting files preserve both versions for
   compare/manual resolution. No within-file automatic merge is promised.
5. The renderer reconciles against the current Draft and applies the result
   atomically in the same synchronous update. Edits made while the accept request
   was in flight are part of that Draft. Unresolved files await resolution.
   Explicit save commits the resulting
   Draft using its source fence; build/preview continues from saved source.

Disk synchronization can advance the saved binding during a turn. Recheck the
current saved binding before acceptance and save, not just renderer state. A
stale proposal remains inspectable. Switching Module does not lose the Draft or
cancel work implicitly; closing with unsaved edits has an explicit warning.

Use a Works harness profile with actual `disallowedTools` names:
`create_automation`, `delete_automation`, `list_automation_targets`,
`list_automations`, `set_automation_enabled`, and `delegate`. Permit sandbox
`bash` only under scratch-container policy needed for coding; host commands and
host mounts and credentials are absent. Coding and builds use the same sandbox
with explicit `network: "unrestricted"`, including dependency installation.
With internet plus `bash`, the agent can reach external hosts. Model API calls
and provider keys stay on the host; sandbox internet access does not place those
credentials in the guest. `allowedTools` is not an allowlist, and disallowed tools
remain advertised, so the UI must display a denied attempt honestly.
An `ask_user` question or approval is surfaced to the owning chat.

Persist Agent Sessions through the Marbles Session store. A
provider/route change that cannot reuse it starts a new Agent Session and warns the
user. There is no promised continuation relationship. Conversation persistence is
distinct from the redacted audit projections.

### Execution integration gap analysis

Marbles is selected. This table compares its integration gaps with the Agents
harness seams available to address them; it does not reopen engine selection.
The common cross-section is built-in coding, streaming, tool permission,
interruption and injectable Session persistence. Neither path supplies Works'
Module-keyed shared sandbox, Draft reconciliation or complete audit projection.

| Needed for chat/workflows | Marbles today (file:line) | `@foundry/agents` today (file:line) | Gap | Options |
| --- | --- | --- | --- | --- |
| Per-Module sandbox reuse | Manual `sandboxes.start` exists; scoped reuse is ledger/frame-based, not Module-keyed ([sandboxes.ts:192](../../marbles/src/lib/managers/sandboxes.ts#L192), [sandboxes.ts:197](../../marbles/src/lib/managers/sandboxes.ts#L197)). | Coding harness accepts host tools and has no sandbox dependency ([builtin-coding.ts:25](../../../packages/agents/src/harness/builtin-coding.ts#L25)). | Works needs a Module-keyed owner and build/turn reuse. | Adapt Marbles to the Works-owned container and provide its tools to the Agents harness; no VM per request. |
| Model/tool observations | Built-in coding passes permission/tools/store but no model `observe` ([session.ts:153](../../marbles/src/lib/sandbox/session.ts#L153)). | `observe` hook plus streamed tool/approval parts ([loop-agent.ts:24](../../../packages/agents/src/agents/loop-agent.ts#L24), [stream-transform.ts:303](../../../packages/agents/src/harness/stream-transform.ts#L303)). | Correlated model-turn and tool evidence on Works coding path. | Wire the Agents observer and stream into Marbles run observations. |
| Run lifecycle subscription | Per-held-run channel stream exists; tracking/settlement is private ([engine.ts:572](../../marbles/src/lib/engine.ts#L572), [engine.ts:843](../../marbles/src/lib/engine.ts#L843)). | Harness exposes turn stream/interrupt, not workflow Run lifecycle ([builtin-coding.ts:40](../../../packages/agents/src/harness/builtin-coding.ts#L40), [turn-driver.ts:118](../../../packages/agents/src/harness/turn-driver.ts#L118)). | Durable/correlated activity lifecycle for chat and registered workflows. | Expose Marbles lifecycle subscriptions and correlate Agents turn start/stream/settlement to engine runs. |
| Named queues and per-queue concurrency | Engine configures one default `marbles` queue with concurrency 1 ([engine.ts:438](../../marbles/src/lib/engine.ts#L438)). | Coding harness supplies turns/tools, not engine queues ([builtin-coding.ts:25](../../../packages/agents/src/harness/builtin-coding.ts#L25)). | Unbounded FIFO `system` admission and independent authoring/workflow concurrency; no queue-length capacity rejections. | Extend engine queue configuration and live admission; apply Module settings at the engine boundary. |
| Non-agent run kinds: save, build, Program lifetime | Works invokes library saves/import/publish directly ([library.ts:153](../src/main/modules/library.ts#L153), [library.ts:245](../src/main/modules/library.ts#L245)); builds and Program watches have their own controllers ([controller.ts:56](../src/main/modules/builds/controller.ts#L56), [controller.ts:52](../src/main/modules/runtime/controller.ts#L52)). | Coding harness is a conversation/tool seam, not a save/build/Program execution engine ([builtin-coding.ts:25](../../../packages/agents/src/harness/builtin-coding.ts#L25)). | Existing paths do not dispatch these actions as engine runs. Long-lived Program stop/crash and committed-but-unrecorded saves need engine semantics. | Register non-agent engine definitions that call existing services, preserve fences/Grants, and record effects. A Program run stays running until stop and becomes interrupted after crash. Settings changes also route through `system`. |
| Durable queued/running Execution Runs | State saves on settlement; reload accepts settled/parked runs, not queued/running ([engine.ts:617](../../marbles/src/lib/engine.ts#L617), [runs.ts:92](../../marbles/src/lib/state/runs.ts#L92), [runs.ts:201](../../marbles/src/lib/state/runs.ts#L201)). | SessionStore persists conversations, not engine runs ([store.ts:22](../../../packages/agents/src/session/store.ts#L22)). | Engine-owned queued/start/progress/terminal records, Module/Agent Session correlation and crash recovery. | Extend the Marbles run store; Works reads it directly, with no wrapper record or duplicate lifecycle. |
| Approvals/questions | Feed-backed live questions/approvals and `ask_user`; live waiting input is marked non-durable ([interactions.ts:231](../../marbles/src/lib/sandbox/interactions.ts#L231), [interactions.ts:432](../../marbles/src/lib/sandbox/interactions.ts#L432), [session.ts:171](../../marbles/src/lib/sandbox/session.ts#L171)). | Permission callbacks, recorded approval requests, host-supplied tools ([permission.ts:105](../../../packages/agents/src/harness/permission.ts#L105), [turn-driver.ts:137](../../../packages/agents/src/harness/turn-driver.ts#L137), [builtin-coding.ts:21](../../../packages/agents/src/harness/builtin-coding.ts#L21)). | Works chat UI routing and truthful cancellation/restart of pending input. | Adapt Marbles interactions to Agents callbacks/question tools and route input to the owning chat. |
| Session persistence | Durable `JsonSessionStore` is exported ([json-store.ts:125](../../marbles/src/lib/sessions/json-store.ts#L125), [index.ts:88](../../marbles/src/lib/index.ts#L88)). | Injectable SessionStore with in-memory default ([session-harness.ts:38](../../../packages/agents/src/harness/session-harness.ts#L38), [session-harness.ts:104](../../../packages/agents/src/harness/session-harness.ts#L104)). | Durable Works conversations without accidentally importing the full engine. | Use Marbles JsonSessionStore through the Agents SessionStore seam. |
| Packaging weight | Lib is built `dist`; bundles internal packages; dependencies include OpenTUI/React/watcher and static CLI drivers ([package.json:26](../../marbles/package.json#L26), [tsup.config.ts:56](../../marbles/tsup.config.ts#L56), [package.json:58](../../marbles/package.json#L58), [session.ts:16](../../marbles/src/lib/sandbox/session.ts#L16)). | Harness exports source paths with a narrower manifest ([package.json:17](../../../packages/agents/package.json#L17), [package.json:42](../../../packages/agents/package.json#L42)). | Packaged Electron dependency loading plus workflow/Session choices. | Package the Marbles engine and required Agents harness seams; verify Electron loading and avoid unnecessary CLI/UI dependencies. |

Use Marbles as Works' execution engine and Agents for its coding/conversation
harness. Extend Marbles' named queues, durable queued/running records, lifecycle
observations and non-agent run adapters; these are implementation work, not an
engine-selection question. Preserve the required-engine startup contract.
Implemented in rows 1a and 8. Marbles has named queues with live concurrency,
durable Execution Runs (`engine.executions`, with observations appended to a log),
host tasks (`engine.task`, `TaskContext.sandbox(container)` for a host-owned VM),
queued-run recovery and retention (`prune`, `gaps`). `Launcher` owns admission.
`@foundry.sh/marbles/engine` is the bundle-friendly entry without CLI providers, and
`@foundry.sh/marbles/statuses` is safe to load in the renderer.
Share existing guest coding tools from Marbles
([coding-tools.ts:21](../../marbles/src/lib/sandbox/coding-tools.ts#L21)) rather than
copying them. Verify packaged Electron loading and keep provider credentials on
the host. Varlock validates the app environment.

## 4. Saves, provenance, and conflicts

### One in-place save contract

File Artifacts and Module source edit ready working Content in place. Each save
carries the last-read `WriteFence`/`ModuleSourceBinding`, or the entry's
`expectedDigest` on the Workspaces path. No actor silently overwrites a changed
base. Artifact `write` preserves ready Content identity and updates its tree/time
([transaction.ts:205](../../../packages/artifacts/src/transaction.ts#L205)); Module
source already checks its binding before writing
([projects.ts:120](../../../packages/modules/src/projects.ts#L120)).

Frozen Content cannot be written. Opening a frozen release for editing creates a
ready working successor once, preserving that release; subsequent saves edit
that working Content in place. Existing Module source makes this distinction at
[projects.ts:133](../../../packages/modules/src/projects.ts#L133). Do not invoke
`revise` on ready Content for ordinary saves: it freezes that Content
([transaction.ts:240](../../../packages/artifacts/src/transaction.ts#L240)).
Only explicit release/freeze creates an immutable snapshot or eligible Version of a Module;
publish already writes with an explicit freeze/tag at
[library.ts:218](../src/main/modules/library.ts#L218). Save history is not Content
history, and save is not release.

In the same transaction as each save, stamp latest host-bound origin and scoped
operation identity on Content metadata, preserving other metadata. Origin holds
actor kind and known Module, Installation, Agent Session/execution identity;
never user-supplied actor identity, provider keys or raw prompts. Initial creation,
disk synchronization and release actions also get typed evidence.

Dispatch saves, disk synchronization and release actions on the engine `system`
queue; persist the run before the fenced storage effect. After commit, record a
typed file/source save result on that engine run. Serialize commit plus result
recording per Artifact, including Module source and disk synchronization. If
engine result persistence fails, report **saved, evidence recovery
required**, retain the committed binding/digest and block that Artifact's next
save until reconciliation succeeds. At startup recover the latest missing save
from origin metadata before accepting another overwrite. This recovers the
latest missing operation, not arbitrary overwritten file history. Compaction
keeps each Artifact's latest reconciled operation identity.

A retry matches scoped operation identity and input against latest origin or the
retained engine run store. A later save may overwrite origin; do not rely on Content
history for deduplication. Reused IDs with changed input fail. If the evidence
was pruned, expose an uncertain result rather than silently write again.
`ArtifactApplicationError` means storage committed but materialized application
needs recovery; do not log recovery as another save or call it rollback.

Put authorization/origin hooks inside the FS mutation transaction, sharing the
manager's scoped operations; wrapping an FS call inside another manager write
transaction is not the composition. Workspaces `save` returns its per-file
conflict result; the provider translates it while retaining both edits.

FS mutation/polling currently performs Artifact writes without Works origin or engine-run
handling ([filesystem.ts:239](../../../packages/artifacts/src/node/filesystem.ts#L239),
[filesystem.ts:279](../../../packages/artifacts/src/node/filesystem.ts#L279)). Include
narrow origin/commit integration for those paths in the file feature; a provider wrapper
alone would miss disk edits. FS currently reapplies stored state on a stale/frozen
disk-write conflict
([filesystem.ts:285](../../../packages/artifacts/src/node/filesystem.ts#L285)); include
preservation/reporting of conflicting disk edits rather than silently replacing them. No
blanket audited facade around every Artifact operation is needed.

### Authority and notification

Subject to the metadata placement confirmation, the authorized save reads the current
Installation, generation and matching Grant through the Artifact-backed ModuleStore
inside the same manager transaction that enforces the Content fence and writes the File
Artifact in place. Revocation updates the same store: whichever transaction commits
first determines the outcome, with no separate revocation lock. A revoke committed
before the save transaction admits its effect prevents the save; a completed save
remains committed. Check binding ownership and cancellation before effects; runtime
changes are checked against durable Installation identity in that transaction.

The Artifact feature includes notification fixes after committed application failure and
recovery: application currently precedes observer delivery, while recovery reapplies
bindings without those observer calls
([manager.ts:305](../../../packages/artifacts/src/manager.ts#L305),
[manager.ts:262](../../../packages/artifacts/src/manager.ts#L262)). Tests must show
subscribers see committed state without counting recovery as a second save.
Frozen-Content annotations also advance `updatedAt`: on a fence conflict, reload and
compare the actual source/entry before offering a refreshed binding. Do not blindly
bypass the fence or add a fingerprint to every revision.

## 5. Shell, explorer, and editor binding

Keep permanent Home/Artifacts at the top, Modules/Settings at the bottom, and
loaded Module shortcuts in the middle. Ship navigation immediately after chat
with a useful initial Artifact listing; expand it into the typed grid later.
Use semantic navigation, keyboard selection, visible focus, and empty/error states.

The grid queries product Artifacts with names, types, thumbnails/fallback icons. Exclude
Module MIME by default but allow explicit Module resolution. Use the existing [Artifact
registry](../../../packages/artifacts/src/registry.ts) for exact type, MIME family,
entry MIME, and fallback behavior. Multi-file Artifacts need a declared primary entry or
an explicit entry picker. Unsupported types remain visible. If multiple editors match,
ask the user and remember a local editor.preference Module setting in host-owned Works
state. Absence offers loading an editor, not an invented built-in editor.
Implemented: the preference is kept per MIME type, naming the chosen Module and
View, in `<userData>/editor-preferences.json` rather than among a Module's
settings, because it settles a choice between Modules.

An editor registration identifies a View, supported MIME types, and read/write mode. An
editor binding is an opaque host-owned identity that pins Artifact, Content, entry path,
access mode, and runtime identity. One binding represents one opened entry; a running
Program can own several bindings. Resolve/read/save requests include a binding ID
checked against that runtime and current Grants. A URL/guest argument cannot confer
access. Open a released View with a binding token; the Program resolves it through its
granted binding Capability. Stop, version selection, close, or revocation invalidates
the binding.

Read returns entry metadata and bounded file chunks. Save includes binding,
base fence, scoped request identity, and edits for that entry; it uses section 4.
The editor retains an unsaved Draft on conflict and warns on close. Explicitly
refreshing to newer Content updates the binding through the host. Read-only
mode cannot save. The fixture proves Markdown create/open/read/save/reopen and
stale-write handling; Tiptap and rich editor selection are separate features.

Core projects under `modules/` use the existing composer/package
import path; no arbitrary Electron plugin loading. The phase-one fixture is loaded
explicitly from a built package and is not preinstalled. Its output files are
File Artifacts, separate from its Module Artifact.

## 6. Manifest, resources, and durable Installation

Keep `foundry.module.json` as the single configuration. Current
`foundry.module/1` Manifests retain their semantics. Use **`foundry.module-manifest/1`**
for the new strict Manifest shape, avoiding the still-imported legacy package
`foundry.module/2` and current package `foundry.module/3`. Gateway remains protocol
1. Readers support both Manifest formats; legacy frozen bytes are not rewritten.
Migration edits authored source; explicit release builds/freezes a new Version. Old readers reject the new format clearly.

Retain compatibility, Program entry, named Views, capabilities, and optional
Drizzle data fields. Add only these declarations:

| Field | Contract |
| --- | --- |
| `resources.memoryBytes`, `resources.cpus` | Positive requested capacities within host policy; omissions use defaults. |
| `resources.storageBytes` | Optional hard private-files limit. Reject when the runtime cannot enforce it. |
| `network` | Requested app network access: `{ destinations: [{ host, ports? }], reason }`, the same destination shape as the sandbox allowlist. Destinations are TLS (HTTPS) only, port 443 unless listed. Declaration alone grants no access. |
| `persistence.files` | `none` or `installation`. Persistent private files belong to the durable Installation; shared Artifacts require capabilities. |
| `settings` | Validated requests/defaults for dot-notation resource, authoring, queue, transfer, idle and editor limits/preferences. Host stores per-Module user values; network, broader Artifact access and host-operation authority are Capability/Grant requests, not settings. |
| `editors[]` | Existing View name, supported MIME types, and `read`/`write` mode. Validate uniqueness and View existence. |

`data` requires Installation persistence. `none` gets disposable writable files
removed after confirmed stop; changing declarations does not delete prior data.
Use `/foundry/program` read-only verified outputs and `/foundry/files` writable
private/disposable files. No guest-selected host paths, secrets, runtime image,
or additional host command. No workflow definitions in the Manifest.

The parser is authoritative, including path and uniqueness refinements that JSON Schema
cannot fully express. Generate JSON Schema as editor assistance and map it to the
configuration filename; schema acceptance alone is not validation. Do not add a
top-level `$schema` to strict Manifests. Full Manifest JSON Schema differs from the
restricted Capability schema dialect. Embedded/retained package agreement continues to
compare canonical parsed values, not bytes. Test both formats through package
import/export and SDK composition; pass the actual capability catalog through
generation/build validation.

Before starting: validate outputs and runtime; resolve resource support; resolve
providers/constraints and missing Grants; prepare private files; then acquire the
sandbox. Required unavailable/denied capabilities block start; optional unavailable
capabilities disable that feature. Implemented: a required, available Capability
without a matching Grant also blocks start (`ungranted-capability`), and the message
points to Access. This feature includes preflight wiring and matching
provider digest/optional semantics. Current preflight hashes raw constraints at
[preflight.ts:56](../../../packages/modules/src/preflight.ts#L56); invocation resolves
the provider digest at
[runtime-dispatcher.ts:80](../../../packages/modules/src/gateway/runtime-dispatcher.ts#L80).
Providers receive raw requested constraints and re-resolve policy on invocation.

Released app network follows the declared request and approved Installation Grant, not a
blanket network-off policy. Approval/revocation lives in the Modules Catalog Access
panel. Resolve current network authority before Program start and apply only the access
the Grant allows; undeclared or denied access is unavailable. The current
[container-runtime.ts:145](../../../packages/modules/src/platform/container-runtime.ts#L145)
hardcodes `network: "disabled"` for released Programs. Grant-moderated networking
requires a framework change; it is not existing behavior. Decided during
implementation; reversible: when the Installation holds a network Grant whose digest
matches the selected Version's normalized destinations, the Program VM starts with
`{ mode: "allowlist", destinations }`; otherwise its network stays disabled
(section 10).

The resource feature includes explicit host round-up so minimum requests are met;
current sandbox conversion uses `Math.round` at
[sandbox.ts:122](../../../packages/sandbox/src/container/sandbox.ts#L122). Hard disk
quotas are not presently established by lifecycle file checks; reject explicit
hard-storage requirements. The existing pids setting maps to a per-user `nproc` rlimit,
not a cgroup guarantee. Validate native resource behavior, not just TypeScript
configuration.

Decided during implementation; reversible: complete the Artifact-backed
ModuleStore against the full store interface and
[conformance suite](../../../packages/modules/src/testing/module-store-conformance.ts).
Store the one Installation and its Grants in its Module Artifact metadata beside
existing identity and retained manifests. Runtime uses this adapter, replacing its
in-memory store and duplicate registration. Installation transitions update Artifact
metadata, not Content time, so they do not stale source bindings.

One Installation per Module survives closing/reopening. Stop/start and Version
selection use framework generation checks; keep the one-writer rule. Grants
live there, with no parallel approval store. The Modules Catalog detail **Access**
panel displays requests, Access scope, Grants, approval and **Revoke** actions.

### Per-Module folder and private data

The proposed installed layout has three top-level directories:

```text
~/.foundry/modules/<moduleId>/
  source/                 # everything buildable
    foundry.module.json   # Foundry config is the Module Manifest
  artifact/               # currently selected release output
  data/                   # data.sqlite plus -wal/-shm/.bak companions
```

`source/` holds package.json, packages/, tsconfig, turbo.json, the Manifest and
other buildable files. Repository core projects at `modules/` are separate from these
installed folders. Resolve identity safely: today portable IDs name their folder
and other IDs use a hash via
[local-library.ts:34](../src/main/modules/local-library.ts#L34); retain the legacy
identity-to-folder mapping during relocation rather than lose existing Modules.

Works selects `~/.foundry/modules` at
[index.ts:26](../src/main/index.ts#L26). Today the Module folder itself is the
workspace source root: materialization
writes source directly into the Module destination at
[local-library.ts:108](../src/main/modules/local-library.ts#L108) and
[local-library.ts:123](../src/main/modules/local-library.ts#L123).
The Manifest source path is root-relative `foundry.module.json`
([manifest.ts:3](../../../packages/modules/src/manifest.ts#L3)). Private files
currently live under `~/.foundry/modules/.data/<moduleDirectory>/`: Works sets
`.data` at [runtime.ts:31](../src/main/modules/runtime/runtime.ts#L31), maps the
Installation to the Module directory at
[runtime.ts:143](../src/main/modules/runtime/runtime.ts#L143), and the files adapter
joins root and mapped ID at
[installation-files.ts:78](../../../packages/modules/src/node/installation-files.ts#L78).
Its database and backup names are `data.sqlite` and `data.sqlite.bak`
([installation-files.ts:26](../../../packages/modules/src/node/installation-files.ts#L26)).

`artifact/` holds real files for the currently selected release's built output,
materialized using the Artifact file-system layer. It is new: Works currently
uses `.runtime/checkouts` at
[runtime.ts:29](../src/main/modules/runtime/runtime.ts#L29), injects checkouts at
[runtime.ts:56](../src/main/modules/runtime/runtime.ts#L56), and removes the runtime
root at shutdown ([runtime.ts:100](../src/main/modules/runtime/runtime.ts#L100)).
Current checkouts extract only runnable outputs from frozen Content
([checkouts.ts:51](../../../packages/modules/src/node/checkouts.ts#L51),
[checkouts.ts:79](../../../packages/modules/src/node/checkouts.ts#L79)). Current
output bytes share the inline JSON backing described in section 2; there is no
existing Works `artifact/` folder in this composition.

Older releases remain frozen in file-backed `blobFiles` storage, independently
of the selected directory. Version selection is an engine `system` run: stop the
old Program, resolve frozen Content, stage and verify its built-output files,
then atomically replace `artifact/` and record the selected Version. Failure
preserves the previous selection and files; restart reconciles an interrupted
switch. Reselecting an older Version rematerializes it from retained blobs.
The app mounts `artifact/` read-only at `/foundry/program`, the current mount
contract ([container-runtime.ts:131](../../../packages/modules/src/platform/container-runtime.ts#L131),
[program-runtime.ts:11](../../../packages/modules/src/platform/program-runtime.ts#L11)).

`artifactFileSystem` currently mirrors an Artifact's active Content, with one
directory per Artifact and polled fenced edits
([filesystem.ts:75](../../../packages/artifacts/src/node/filesystem.ts#L75)). It does
not provide this selected-frozen-Version/output-only path mapping today. Extend
its materialization seam for a selected Content/output projection and custom
Module destination, without changing the Module's active working Content or
polling released output back as source edits. Reuse its file application layer,
not a second independent checkout implementation. The runtime's checkout adapter
then resolves this verified `artifact/` projection instead of a temporary copy.

The database lives in `data/`: `data.sqlite` and its `-wal`, `-shm` and `.bak`
companions. Only `data/` is mounted read-write into the app sandbox. `artifact/`
is mounted read-only as the Program; `source/` and its config are never mounted
into the app sandbox.

The Foundry config is the Module Manifest, `source/foundry.module.json` on disk.
The agent edits it like any other source file, with the same Draft review and
save fences. No separate top-level config or build-input mapping is required.
SDK generation uses `source/` as its workspace root; packaging preserves the
existing `source/foundry.module.json` entry inside Version Content
([Modules glossary:15](../../../packages/modules/GLOSSARY.md#L15),
[version.ts:20](../../../packages/modules/src/version.ts#L20),
[package.ts:338](../../../packages/modules/src/package.ts#L338)).
`writeModuleGatewayClient` reads the Manifest at its workspace root
([emit.ts:45](../../../packages/modules/src/sdk/emit.ts#L45)). Manifest declarations
request requirements; they grant no authority. Approval/revocation happens only
in the host Access panel, independently of agent edits to the Manifest.

Agent/build sandboxes receive only `source/`, including its Manifest; never mount
the Module folder, database, `artifact/` or anything outside `source/`.
The app mount remains the directory-based Installation files contract, restricted
to `data/`, alongside read-only Program output
([container-runtime.ts:131](../../../packages/modules/src/platform/container-runtime.ts#L131)).
Update `dataId`/files-path resolution and allowed mount roots to the Module's
`data/`; do not retain `.data` as the final location or mount the Module parent.

Move existing private data once, only after confirmed Program stop and database
closure. Stage a consistent copy including required SQLite companions, verify
integrity and reopen at the selected destination, then atomically adopt the new
path. Keep the original until verification succeeds; failure leaves it usable.
Persist migration state for idempotent restart and refuse conflicting destination
contents. Relocate existing workspace source separately without dropping pending
disk edits. This replaces the earlier no-migration decision.
`persistence.files: none` uses a distinct disposable database location, removed
only after confirmed stop; it never touches persistent Module data.

The adapter currently paginates Module Artifacts to find registration. Accept
that scan on each Gateway context lookup at local scale. Installation transitions
also rewrite the JSON store; prove behavior with the real adapter before adding
an index/cache. Metadata validation and failed-write rollback are conformance gates.
On restart, reconcile stale runtime identities through framework lifecycle rules
before allowing new start; persisted active status is not proof of a live VM.
Database changes use existing backup/migration contracts and confirmed stop;
there is no promised live upgrade.

## 7. Module-facing host operations

Use one owner-namespaced Capability per operation as a design choice for clear Grant
scope. It is not forced by the portable schema dialect: an `operation` enum with
application validation is also possible; enum and object fields exist in
[manifest.ts:56](../../../packages/modules/src/manifest.ts#L56). Constraint resolution
and invocation share one policy implementation. Test raw constraints versus resolved
digest matching. Modules Capability/Grant authority is separate from Agents tool
permission policy.

| Proposed operation | Mode | Scope and effect |
| --- | --- | --- |
| `works.editors.binding` | unary | Resolve a supplied binding ID owned by this runtime. |
| `works.artifacts.read` | unary | Read bounded chunks authorized by a binding or approved broader Artifact scope. |
| `works.artifacts.list` | unary | Enumerate only Artifacts covered by an approved broader Access scope. |
| `works.artifacts.watch` | stream | Initial authorized Artifact/entry snapshot and committed changes, using a runtime-owned binding or approved broader observation scope. |
| `works.artifacts.save` | unary | Fenced save of that entry, with host attribution. |
| `works.artifacts.create` | unary | Validate type/size against Grant constraints, create a File Artifact, and return a new entry binding owned by this runtime. |
| `works.execution.start` | unary | Start a permitted host-registered workflow ID/version with validated input. |
| `works.execution.watch` | stream | Snapshot and updates of an execution owned by the caller. |
| `works.execution.cancel` | unary | Cancel that caller's execution through its owning engine. |
| `works.system.theme` | stream | Initial theme slice and subsequent updates. |

`artifacts.access` defaults to binding-only: opened or created entries belonging
to the current runtime. Broader list/read access to other Artifacts is configurable
per Module through operation-specific Grants, shown and revocable in Access.
Manifest requests do not authorize access; providers enforce approved
resource/action scope. Declining broader access leaves binding-only behavior. Creation has
explicit constraints: allowed MIME types and maximum decoded bytes within host
limits. It creates one primary entry in the local product store, not an arbitrary
host folder or an enumerable collection. Require matching read/save Grants for
the runtime-owned-binding scope before creating a writable binding; creation
does not mint those Grants. Return Artifact/Content/path and the new binding ID,
so the fixture can immediately read and save it. Validate current Grants inside
the creation transaction too. A retried create resolves its committed operation
identity and remints a binding only for a currently authorized runtime.

All start at capability version 1. Implemented: Works registers all ten through
`worksCapabilities` (`src/main/modules/capabilities.ts`); they are Works
registrations, not framework exports. Host explorer/list/resolver operations remain core Works interfaces.
Guest enumeration and Artifact observation follow the selected Access scope. Approved
broader access exposes the corresponding operations. Host editor bindings refresh from
Artifact observations.

`works.artifacts.watch` requires its own matching Grant. A binding-scoped request
names a binding owned by the current runtime; broader observation uses explicit
approved Artifact scope and must not reveal other identities or files. Subscribe
before taking the initial snapshot, then reconcile changes by Artifact/Content
identity and committed source fence or entry digest. Deduplicate repeated committed
state; no new per-save Version is introduced. Include changed entry metadata and
removal signals; file bodies still use authorized `read`. Reconnect requests a
fresh snapshot and reports any missed-history gap rather than promising replay.
An update never replaces unsaved editor changes: surface the new saved base and
retain the Draft for conflict resolution. Close/stop, iterator cancellation and
Grant revocation release the subscription; revocation prevents further delivery.
Observe committed saves after application recovery without treating recovery as
a second save. The fixture verifies initial state, changes, stale Draft retention,
reconnect, deletion, scope denial and revocation.

Start records the request before effects, reuses matching request identity for
safe retries, and rejects identity reuse with changed inputs. Observing/cancelling
another runtime's work fails even if its execution ID is guessed. A Module may
coordinate its own workflow inside its Program using authorized host operations;
it cannot submit executable workflow definitions for host evaluation.

For released apps, an approved network Grant becomes the sandbox destination
allowlist at Program start (decided during implementation; reversible; section 10).
Revocation removes that access by stopping and restarting the open app under the
updated policy. The revoke reports done only after the old Program's stop is
confirmed. If that stop fails, the revoke reports the failure and tells the user to
turn the Module off. Do not leave prior network authority active after revocation
is reported complete.

Revoking a Grant cancels active Invocations, invalidates related bindings/streams,
and prevents new effects. Already committed saves remain history. API keys and
integration secrets resolve on the host and never enter the theme slice,
Manifest, output package, scratch filesystem, or audit payload. No local user
system or arbitrary environment-variable sharing is introduced.

## 8. Reactive theme connection

Main persists validated mode `auto | light | dark`, maps it to Electron
`nativeTheme.themeSource`, and publishes `{mode, effective, revision}`. The renderer's
existing theme selector uses trusted RPC without UI redesign. On first migration, import
its existing localStorage mode before opening Modules; subsequent starts read main's
preference before creating windows. OS changes advance effective appearance only in auto
mode. Native theme keeps CSS media queries and window background aligned with effective
appearance, following [Electron nativeTheme
semantics](https://www.electronjs.org/docs/latest/api/native-theme).

The theme Capability emits an initial snapshot and host revisions, read-only.
Subscribe before reading the snapshot, discard duplicate revisions, and refresh
after reconnect. Coalesce changes to the latest snapshot rather than buffering
an unlimited stream. Denial supplies no mode state; native effective appearance
remains available through CSS. Receiving a slice cannot change global preference.
Older Programs may not serve the relay; the proxy maps upstream errors to 502.
Any non-success relay response means unavailable: clear explicit mode state and
fall back to CSS effective appearance, rather than expecting a particular 404.
A failed initial connection or disconnected reader has the same fallback until
an authorized fresh snapshot is received.

A Program consumes this through the existing Gateway SDK. Its browser View needs
a small relay: a composer-provided same-origin stream route `/_module/theme`
beside `/_module/graphql`. The browser helper uses `fetch` and a streaming reader
for validated SSE theme snapshots, with abort/reader cleanup; custom-scheme
`EventSource` support is not assumed. This is new SDK/composer work.

Keep the `/_foundry` private-prefix deny unconditional, including the Program's
`/_foundry/module-gateway` socket. Use one small proxy route table describing
path, allowed methods and lifetime: GraphQL permits POST with the existing short
lifetime; theme permits GET with a view/runtime-bound streaming lifetime. Derive
path admission, method checks, timeout and upstream connection-header behavior
from that table; omit `connection: close` for the stream. Preserve View/static
file admission and their current short lifetimes, origin checks and CSP. Native
fetch streaming over `module-app:` needs acceptance testing. No generic event bus
is required. A relay disconnect closes its Gateway iterator; reconnect opens a
fresh authorized subscription. Revocation ends the relay and clears explicit
mode state in the View. Do not leave a browser response alive after Program stop.

Implemented: the per-path route table was replaced by one rule, because the Artifact
and execution routes in rows 6 and 7 would each have needed a row. Under `/_module/`,
a GET whose `accept` asks for `text/event-stream` is a stream. Other GET, HEAD and
POST requests there are short requests, and other methods get 405. Elsewhere only
GET/HEAD of a View or static file is admitted. `/_foundry*` and `/_module/gateway*`
stay 404 for every method. POST bodies over 2 MiB get 413, and paths containing
`//` are refused.

The theme/execution streaming feature includes the SDK fixes: pending `next()` rejects
on socket failure, iterator `return()` sends `cancel`, removes pending state and
releases resources. Today failure leaves the waiter unresolved and return only ends the
queue ([source.ts:166](../../../packages/modules/src/sdk/source.ts#L166),
[source.ts:168](../../../packages/modules/src/sdk/source.ts#L168),
[source.ts:183](../../../packages/modules/src/sdk/source.ts#L183)). Add real WebSocket
transport tests for close, cancel, complete, late frames, and reconnect. These fixes
belong to this feature, not a separate gate. The relay itself needs an actual sandbox
browser test: Gateway unit tests alone do not prove proxy streaming works.

Future user-context slices can follow this contract, but their authorization
and payloads belong to phase two. Phase one shares only the theme slice.

## 9. Modules auditing and persistence

Everything Works documents runs through the execution engine as an Execution
Run. The engine owns durable run identity, queue admission, progress and terminal
outcome; Works keeps no wrapper Run record. Agent Session generate/stream work
happens inside a run. Builds and Program lifetimes target the same model. A
Program lifetime is long-running until stop; a crash leaves it interrupted,
not successful. Current non-agent adapter and persistence gaps are in section 3.

Catalog remains the management surface, beside Dashboard, Calls, Workflow Runs,
Execution Runs and Artifact Saves. Audit views read engine runs and their typed
observations; Access approval/revocation stays in Catalog detail.

| Tab | Source and meaning |
| --- | --- |
| Dashboard | Engine-run counts and available usage, with Module/time scope and measurement coverage. |
| Calls | Engine-correlated model-turn, tool-call and Gateway observations. Model turns are not necessarily individual provider HTTP requests. |
| Workflow Runs | Engine runs of registered workflows, preserving supported waiting/suspended states. |
| Execution Runs | Engine-owned durable runs on named queues, with Module/Agent Session correlation and start/progress/outcome. Includes non-agent kinds as their adapters land; failed-save runs have an attempts filter. |
| Artifact Saves | Committed save results on engine runs, including file/source/release kind, host-bound origin and recovery status. Failed attempts are not saves. |

### Evidence coverage evaluation

Decided during implementation; reversible: there is no separate Works evidence log.
The engine run store covers saves, failed saves, imports, publish, settings changes,
builds and Program lifetimes, including typed effect/result observations, retention
and recovery. No action inherently requires a second Works log. Implemented in row
8: every documented action is a named engine run. These are Module create/import,
source save (`works.source.save`), disk sync (`works.source.sync`) and save
recovery (`works.source.recover`), build,
publish, Version select, Program lifetime, settings, Access, power, authoring turns,
registered workflows, and file create/save/sync/revise/recover. Gateway invocations
are observations on their Program run. Failed file saves record a typed `attempt`
result, not a save. Pre-dispatch refusals, editor-preference writes and reads are
not runs. Slice 8 found no existing Works log to remove.
There is no retained uncovered subset in this design.

Engine retention preserves each Artifact's latest reconciled save checkpoint and
scoped operation identity. Content metadata supplies only the latest origin for
reconciling a committed effect whose engine result write failed (section 4).
Authoring snapshots/proposals and editor preferences remain Works state, not
run-store copies. Agent Session history has separate conversation persistence.
Read queries join by IDs; product records and execution storage remain separate.
Future SQLite adapters preserve these contracts.

Persist queued runs before admission and running status before effects. Record
progress and terminal outcomes durably, with source-identity deduplication. On
restart, interrupted running work is visible; reconcile storage effects and live
Program cleanup without blindly replaying effects. Queued work requires explicit
safe admission/recovery, not silent loss. Implemented: Works starts the engine with
`recoverQueued: true`. Run bodies are never persisted, so a dead process's queued
Works run is re-admitted and fails as `AbandonedRequest` without effect. Read retained runs, subscribe and
reconcile by stable identity/revision; disconnect refreshes a snapshot. Surface
retention gaps. A subscription alone does not establish crash durability.

### Named queues

All Execution Runs use named FIFO engine queues. `system` owns existing Works
work: saves, publish, import, settings and Grant changes, and builds/Program
lifetimes where their adapters fit. It has no length limit: requests are never
rejected for queue capacity. Unlimited describes admission, not concurrency.
Admission/dispatch preserves FIFO order; saves to the same Module commit in
request order, including disk/agent saves. Preserve this order across restart.
Per-Artifact transactions and Installation lifecycle rules still protect effects.
FIFO does not mean waiting for a long-running Program's terminal outcome before
starting later work; its start is ordered and its lifetime remains tracked.

Module authoring and workflows use separate named FIFO queues keyed by Module
and work kind, with concurrency from Module settings (section 10). There are no
queue-length caps or capacity rejection paths; excess concurrency waits its turn.
A backlog in one queue does not consume another queue's admission. Queue
concurrency bounds active work; Module sandbox ownership and machine ceilings
independently bound VMs. Sandbox capacity waits do not reject queued requests.
Chat turns and builds run in parallel in the Module sandbox. Snapshot isolation
below the application layer is the intended contract, but that layer does not exist
yet: today they share one VM (see "One Module sandbox owner" in section 10). Works
does not queue one behind the other or implement a new snapshot mechanism. Program
lifetimes do not occupy a limited authoring/workflow slot.

The required engine starts and recovers its queues/run store before Works accepts
saves, settings mutations or launches. If startup fails, report a Works startup
failure and do not accept those actions through direct service fallbacks.

Keep missing usage/cost unknown. Preserve units, source and estimated/measured
classification when a provider actually supplies them. Engine observation defaults record
identity, kind, timing, status, safe error code, and known usage; omit raw
prompts/arguments/results and file bodies. Agent Sessions contain conversation
history for the chat and have separate persistence/access semantics. Legacy
history remains unknown rather than backfilled with invented observations.

## 10. Module settings, defaults, and host ceilings

Per-Module settings are in phase one. Global/application Settings stays unchanged;
no new global controls or environment-variable policy overrides. Dot-notation
keys are declared/validated through `foundry.module.json` requests/defaults; the
host persists user values by Module ID. The parser is authoritative. Effective
values combine user choice and Manifest requirements, capped by host ceilings;
reject an unmet required minimum rather than silently underprovision. Limits
and preferences are Settings. Anything granting Module authority is a
Grant: network, access beyond bindings and host operations. Grants are shown and
revocable in Access; setting edits never grant authority.

Decided during implementation; reversible: the Module settings UI is in Catalog
detail beside Access, on the **Access & settings** tab. Access
continues to approve/revoke Grants; settings edits do not approve access. Store
user values in Works state, not guest files or environment variables. This host
settings record is a new contract, not a claim about the current Settings screen.

The chart covers both kinds explicitly: Grant rows are managed in Access, not
the Module settings editor; Setting rows hold limits/preferences. `host.operations`
summarizes the operation-specific requests in section 7, not a wildcard Grant.
The contracts below are required in phase one; none remains open. Numeric
values are recommended starting points for experiments, not approved defaults,
mandatory ceilings or acceptance gates. Measure representative workloads and
select actual values during implementation; document the results and trade-offs.
This distinction does not weaken decided authority, save, FIFO or availability
rules. Retention recommendations must preserve active runs and save recovery.

| Key | Kind | Meaning | Recommended starting point / decided rule | Who sets it | Enforced where |
| --- | --- | --- | --- | --- | --- |
| `resources.memoryBytes` | Setting | Optional per-Module memory allocation; omissions use a host default tuned experimentally. | Experiment with the shared sandbox default; current build uses 2 GiB ([runtime.ts:62](../src/main/modules/builds/runtime.ts#L62)); current released Program uses 512 MiB ([container-runtime.ts:151](../../../packages/modules/src/platform/container-runtime.ts#L151)). | Manifest request/default; user value; experiment with a 2 GiB host per-sandbox ceiling and machine budget below. | Works sandbox coordinator and released runtime; include unit-rounding fix. |
| `resources.cpus` | Setting | CPU capacity per sandbox. | Recommended: 1; trial host ceiling 2, subject to sizing experiments. | Manifest request/default; user; host ceiling. | Sandbox start/update under the chosen runtime. |
| `network` | Grant | Released app network scope; authoring/build always has internet. | Exactly approved Grant; undeclared/denied access unavailable. TLS-only destinations (decided during implementation; reversible). | Manifest request; user requests/approves in Access; host enforceable scope. | Sandbox destination allowlist at Program start; approve/revoke restarts the open app. |
| `artifacts.access` | Grant | Binding-only baseline; broader list/read authority is a Grant. | Binding-only; broader scope is grantable. | Manifest request; user approves/revokes in Access; operation Grants/host scope. | File providers and FS-backed authorized saves. |
| `authoring.deadline` | Setting | Coding-turn deadline, distinct from sandbox lifetime. | Recommended: 10 minutes; recommended trial host ceiling 10 minutes. | Manifest request/default; user; host ceiling. | Host turn cancellation; retain the sandbox while its Module is on. |
| `authoring.maxSteps` | Setting | Model steps per coding turn. | Recommended: 20; recommended trial host ceiling 20. | Manifest request/default; user; host ceiling. | Coding harness profile. |
| `authoring.source.maxFileCodeUnits` | Setting | Text-file admission in UTF-16 code units. | Recommended: 4,194,304; trial ceiling same, subject to sizing experiments. | Manifest/user may lower; host ceiling. | All source admission paths. |
| `authoring.source.maxBytes` | Setting | Total source admission in UTF-8 bytes. | Recommended: 16,777,216; trial ceiling same, subject to sizing experiments. | Manifest/user may lower; host ceiling. | Snapshot, disk and agent source admission. |
| `authoring.source.maxFiles` | Setting | Source entry count. | Recommended: 2,048; trial ceiling same, subject to sizing experiments. | Manifest/user may lower; host ceiling. | Source admission. |
| `authoring.source.maxPathCharacters` | Setting | Source path length. | Recommended: 512; trial ceiling same, subject to sizing experiments. | Manifest/user may lower; host ceiling. | Source path validation. |
| `artifacts.maxFileBytes` | Setting | Editor fixture file limit. | Recommended: 16 MiB; trial ceiling same, subject to sizing experiments. | Manifest/default; user; host ceiling. | File provider and Workspaces save; blob manager retains build-compatible limits. |
| `artifacts.chunkBytes` | Setting | Decoded transfer chunk size. | Recommended: 256 KiB; trial ceiling same, subject to sizing experiments. | Manifest/default; user; Gateway frame ceiling. | File delivery/assembly. |
| `explorer.pageSize` | Setting | Module-facing page size. | Recommended: 100; trial ceiling same, subject to sizing experiments. | Manifest/default; user; host ceiling. | Scoped enumeration. |
| `audit.retentionDays` / `audit.maxTerminalEntries` | Setting | Per-Module terminal evidence retention. | Recommended: 30 days / 10,000 entries; trial ceilings same, subject to retention experiments. | Manifest/default; user; host engine-store ceiling. | Engine run-store compaction; preserve latest-save checkpoints and active evidence. |
| `host.operations` | Grant | Authority to invoke host operations from section 7. | No authority without the matching approved Grant. | Manifest request; user approves/revokes in Access. | Gateway admission and provider transaction checks. |
| `queues.authoring.concurrency` | Setting | Concurrent authoring runs for this Module. | Recommended: 1; recommended trial host ceiling 1; experiment with per-Module concurrency. | Manifest request/default; user; host ceiling. | Named engine authoring queue admission. |
| `queues.workflows.concurrency` | Setting | Concurrent workflow runs for this Module. | Recommended: 1; recommended trial host ceiling 4. | Manifest request/default; user; host ceiling. | Named engine workflow queue admission. |
| `sandbox.idlePolicy` | Setting | Preserve the live sandbox while the Module is on, including idle service providers. | Keep on while Module is on; no idle timeout. | Fixed phase-one lifecycle rule; settings cannot override it while the Module is on. | Works Module-scoped sandbox owner; explicit Module-off/host-shutdown cleanup. |
| `editor.preference` | Setting | Handler preference when several editors match. | Ask on first ambiguity. | Manifest compatible editor declarations; user selection. | Resolver, persisted per MIME type in Works state (`editor-preferences.json`), not in the per-Module settings record. |

Autoscaling-specific bounds, CPU/memory pressure measurements, automatic
resizing, cooldowns and safe standby are one
[phase-two feature](PHASE-TWO.md#bounded-module-resource-autoscaling). Phase one
requires none of that controller's settings or instrumentation. It uses explicit
resource allocations through Module settings, capped by host capacity. Numeric
resource proposals below are not user-approved sizing.

The source defaults above mirror current RPC checks at
[modules.ts:12](../src/main/api/router/modules.ts#L12); extending them to settings
and other entry paths is new work. Framework build resource baseline is cited,
not a decision selecting the merged default. Global settings are deferred, so
machine-wide limits will use fixed code defaults in phase one. Four live
sandboxes and 8 GiB total reserved sandbox memory are recommendations to test,
not chosen defaults. Count authoring/build and released app sandboxes together.
Experiment with actual usage, dependency availability and constrained machines
before selecting values. They do not set a global turn count. Effective
allocations cannot exceed the selected host ceilings. Existing code values are
baselines for comparison, not evidence that they fit every Module.

Transport/page/retention values above are Module settings within host ceilings.
`system` FIFO has unbounded length, not an unlimited-concurrency setting. Other named
queues added later must expose their own dot-notation concurrency key, with
validated defaults and host ceilings. Queue concurrency values above are trial
recommendations; no queue-length caps are introduced.
Recommended storage experiments start with a 32 MiB JSON record-size target and
a 250 ms p95 metadata-commit target on a recorded SSD host. These are hypotheses
to measure and tune, not mandatory acceptance thresholds or Module permissions. Save history is engine-run observations, not
retained Content per keystroke/save. Measured: 100 Installation/Grant commits had
p95 9.0 ms, and `artifacts.json` stayed under 210 KB in every storage run; full
results are in section 11.

Implemented defaults: the values in the table above, plus four live sandboxes,
8 GiB reserved sandbox memory, 512 MiB for a released Program, and a 2 GiB ceiling.
All are code constants taken from these recommendations unchanged; no workload
experiment tuned them. Manifest `resources.*` values are minimums that raise host
defaults, never lower them. The authoring queue's host ceiling stays 1, because turns
of one Module share `/workspace` and one Agent Session. Two constants were added
during implementation: unclaimed editor bindings expire after 30 minutes, and each
Program run records at most 500 Gateway call observations, then a count.

### Decisions taken during implementation

These were the open and confirmation decisions. Each was decided during
implementation; reversible.

- **Evidence coverage:** no separate Works evidence log. All documented
  action/result coverage is in the engine run store (section 9).
- **Enforcing app network Grants:** sandbox destination allowlist from the approved
  Grant (`network: { destinations: [...] }` in
  [constraints.ts:58](../../../packages/sandbox/src/container/constraints.ts#L58)),
  not a host Gateway fetch. The Grant is `{capability: "network", version: 1}`
  with the digest of the normalized destinations. At Program start a matching Grant
  yields `{ mode: "allowlist", destinations }`; anything else leaves network
  disabled. Microsandbox enforces host-name egress rules natively with default deny
  and TLS interception, which verifies upstream certificates on every listed port.
  So destinations are TLS only: plain HTTP to an approved host is denied (fails
  closed), as the Manifest schema and Access copy state. Approving or revoking
  network access stops and restarts the open app under the new policy. The cost is
  that the restart cancels that Module's running workflows.
- **Installation/Grant metadata:** small authority records on Module Artifact
  metadata after externalizing new bytes, through `createArtifactModuleStore`. It
  passes the ModuleStore conformance suite on a real JSON store.
- **Module settings UI:** Catalog detail beside Access (**Access & settings** tab).

### One Module sandbox owner

Works owns a Module-keyed sandbox coordinator. Create one sandbox on demand;
requests for that Module route to its live sandbox instead of starting a VM.
Agent turns and builds borrow it without owning destruction. While its Module
is on, keep the sandbox on even when idle; it may provide services to other
Modules. Do not evict it or apply an idle timeout to free capacity. Requests
needing more capacity remain queued. Explicit Module-off and host shutdown
perform confirmed cleanup. Reconcile edit
proposals through the Draft contract. Chat turns and builds proceed in parallel;
the user-owned underlying snapshot technology is to keep their source inputs
isolated. Integrate that snapshot contract without adding application-level
serialization or choosing a new isolation mechanism here.

Implemented: that snapshot layer does not exist yet, and nothing below the
application layer isolates a chat turn from a build. Both run in the Module's one
VM and share its kernel, `/tmp`, network and CPU. The mitigation (fix waves 1
and 7) has four parts. The agent's tools run as the image's unprivileged `bun` user
through an explicit allowlist wrapper, and its writes are staged and copied as
`bun`. Builds run as root in `/builds/<uuid>`, outside `/workspace`, in a root-owned
`0700` directory with their own `TMPDIR`. Seeding and collecting a turn first end
every `bun` process. Each turn reseeds `/workspace`. This was verified natively: the
guest cannot list or read `/builds`, and a planted symlink into it is refused. It
is not snapshot isolation; a compromised sandbox kernel reaches both. Model/API traffic and provider keys stay on the host, while guest
`bash` can reach external hosts. Released app sandboxes remain separately
Grant-moderated. Stop/restart and host shutdown require confirmed cleanup.
Turn/build requests reuse the owned sandbox rather than allocate a VM.
Current builds call `containers.start` per run
([runtime.ts:51](../src/main/modules/builds/runtime.ts#L51)); adapting both build
and selected agent path to the owner is new integration work.

## 11. Feature sequence and verification

Each row is reviewable independently. Chat uses current source fences; shared
Artifact/editor/audit features do not precede it as a wholesale foundation. Minimal
execution records ship with chat, latest origin and engine-run observations with save support,
and later tabs assemble those real observations.

| Order | Feature and owner | Acceptance gate |
| --- | --- | --- |
| 1a | Works Module sandbox owner and Marbles execution adapter | Repeated Module requests reuse one sandbox; machine ceilings, observations, durable queued/running/terminal engine runs, generate/stream correlation, FIFO admission without capacity rejection, per-queue concurrency, required engine startup/failure and crash recovery, packaged import and app environment validation are verified. Marbles integration gaps are implemented and verified. |
| 1b | Works authoring side chat | Request produces a reviewable proposal; accept/save/build/preview works; disjoint typing accepts and overlapping edits conflict safely; shared authoring/build sandbox has internet access while host credentials remain absent; questions, denial, cancellation and restart retain truthful state; chat and builds proceed in parallel against isolated snapshots supplied by the underlying technology. |
| 2 | Works permanent navigation and initial explorer | Required icon placement, keyboard access, useful listing, Module shortcuts and existing Settings preserved. |
| 3 | Module configuration/settings, confirmed authority store and Access panel | Both formats round-trip; quotas enforced or rejected; existing private data reopens after a verified one-time move, with originals retained until success; source includes its editable Manifest and excludes private data from authoring/build input; only data/ mounts read-write into the app; start/stop does not stale source bindings; matching Grants carry over and changed requests re-prompt; selected-release `artifact/` files match the Version, older Versions reselect and the app mount is read-only; declared-and-approved app network works, undeclared/denied/revoked network does not; revoke works; new editor/build blobs use files and store/save-dispatch latency is measured and sizing recommendations are evaluated; Module setting validation, user overrides, host ceilings and broader Artifact Grants are verified. |
| 4 | Modules SDK/composer, Works main theme/proxy | Pending stream failure/cancel fixed; initial and live mode/effective state verified in a sandbox View; private Gateway paths remain inaccessible from the View; OS, explicit override, revoke, close and reconnect release resources. |
| 5 | Works grid/resolver | Type/MIME precedence, explicit Module resolution, fallback, multi-file picker, thumbnails and editor selection are visible and correct. |
| 6 | Editor binding, file save provider, core fixture | Markdown Artifact create/read/save/reopen through returned binding; several owned bindings work; read-only and foreign bindings denied; stale save preserves edits; authorized Artifact watch initial/change/reconnect/revoke behavior and unsaved Draft retention verified; in-place identity, origin/engine-run history and request retry verified. |
| 7 | Module execution providers and registered workflow fixture | Guest starts/watches/cancels allowed work; another runtime's IDs fail; keys stay host-side; Module sandbox reuse supports parallel chat/build work through the supplied snapshot contract; idle sandboxes stay on while their Module is on. |
| 8 | Engine run-store coverage and Modules audit projections | Committed file/source/release saves attributed; failed engine result write recovered before next overwrite; Calls populated by real coding; unfinished work survives crash; failures never appear as saves. |
| 9 | Core Artifact API consolidation and reconciliation journey | Human/agent/fixture writers share fences and recovery; observer application/recovery gaps fixed; no duplicated storage, execution engine, or approval authority. |

Rows 1b and 7 name isolated snapshots supplied by the underlying technology. That
layer does not exist yet; turns and builds run in parallel in one VM under the
mitigation in section 10, which those rows do not fully meet. `test:module-native`
verifies the parallel journey natively: one VM is created for both; the build starts
installing while the turn runs, and the turn's tools keep editing scratch files
during the build; the guest user's `ls`, `touch` and `cat` on `/builds` fail; the
release source equals saved source plus `bun.lock` and the selected `artifact/`
holds none of the scratch edits; the proposal accepts while the build still runs.
Copies plus user separation keep each side's input unchanged by the other. They do
not isolate below the application layer: the agent read the build's process command
lines from `/proc`, and both share CPU, memory, the process limit, `/tmp` and
network. Commits and
verification per row are in [PHASE-ONE.md](PHASE-ONE.md#implementation-status).

Feature 3 measures the real shared manager/JSON store. Recommended starting
fixtures are ten distinct 64 MiB aggregate release outputs and 1,000 in-place file
saves; adjust sample sizes to representative usage rather than treating these
counts as mandatory acceptance gates. Exercise repeated saves
with engine-run save history. Inspect new blob records/backing files and verify
maximum-size rejection; saves preserve working Content identity and only explicit freeze
creates snapshots. Measure JSON size and p95; an initial recommended sample is 100 metadata commits
spanning
Installation and Grant changes; record hardware, history size, and lock-wait versus
commit duration. Measure full editor save latency separately including blob staging and `system`
queue dispatch/durable recording. Compare identical fenced saves with and without
engine routing on the same SSD host, including concurrent authoring/workflow and
long-lived Program runs. Acceptance: routing adds no noticeable editor delay;
use 50 ms p95 added latency as a recommended experimental target, not a fixed
pass/fail threshold. Tune against measurements and actual editor interaction,
with visible pending feedback and no save waiting on an authoring/workflow slot. Verify FIFO saves to the same Module
commit in request order, queued work survives restart, and concurrency/sandbox
capacity waits never become queue-length rejection. Record distributions, not just means.
A missed recommended target prompts investigation and sizing experiments; it
does not itself fail acceptance. Noticeably slower editor saves still fail the
user's requirement. Never silently sweep history or add an unplanned migration
to meet a recommended number.

### Experiment results

Measured during implementation on one Apple M4 Max (48 GiB, local SSD, Node 26.4),
with `JsonArtifactStore` and `JsonStateStore`. Lock wait and commit time were not
split. These are single-host samples, not sizing conclusions.

| Measurement | Result | Against the recommendation |
| --- | --- | --- |
| Engine routing of fenced source saves (starter Module, 40 files, inline bytes, n=200 alternating) | Direct p50 41.3 / p95 49.6 ms; routed p50 42.2 / p95 53.1 ms. Adds 0.9 ms p50, 3.5 ms p95. | Within the 50 ms p95-added target. |
| Same, with file-backed blobs and disk sync (starter plus 2 KiB README, 1,000 alternating) | Direct p50 56.3 / p95 65.4 ms; routed p50 56.8 / p95 66.0 ms. Adds about 0.5 ms. After 1,000 in-place saves: 40 backing files (61 KB), `artifacts.json` 25.9 KB. | Within target. Saves stay in place; JSON does not grow with payloads. |
| File-backed versus inline blob (core fenced save, n=200 each) | Inline p50 10.9 / p95 12.9 ms; file-backed p50 18.9 / p95 21.2 ms. | About +8 ms p50 from one file fsync and one directory fsync per published blob. |
| Release publishes (10 distinct outputs of about 8 MiB each, smaller than the recommended 64 MiB fixtures) | p50 154 / max 184 ms. Afterwards: 122 backing files, 80.1 MiB, `artifacts.json` 204 KB; routed saves p50 65.2 / p95 73.3 ms. | Far below the 32 MiB record-size hypothesis. |
| Installation/Grant metadata commits (100 Access approve/revoke `system` runs) | p50 8.0 / p95 9.0 / max 22.3 ms; `artifacts.json` 28 KB. | Well inside the 250 ms p95 hypothesis; no index or cache needed. |
| File Artifact save end to end (`ProductFiles.save`, 2.4 KB Markdown, n=100) | p50 33.9 / p95 39.0 / max 40.7 ms. | Not noticeably slow. Each save rewrites the JSON records twice (write, then FS apply), the first thing to change if saves need to be faster. |
| Works main bundle | 638 KB before Marbles; 4.2 MB with `@foundry.sh/marbles/lib`; 3.1 MB with `@foundry.sh/marbles/engine` and lazy CLI drivers (loaded only if a CLI harness runs). | No OpenTUI in the bundle. |

Native resources (`test:module-native`, Microsandbox on the same machine): a
setting of 1.5 CPUs and 1.5 GiB + 512 KiB creates 2 vCPUs and 1,537 MiB in both the
authoring/build VM and the released Program VM (guest `nproc` 2, `MemTotal`
1,481 MiB); a strict Manifest's minimum of 2 CPUs and 1 GiB gives a Program 2 vCPUs
and 1,024 MiB (`MemTotal` 982 MiB) and the authoring VM 2 vCPUs at its 2 GiB
default. The guest kernel keeps about 3 to 4% of memory. The Version-switch backup
and the private-data move ran on Electron 43.7.7's Node 24.21.0 (SQLite 3.53.4).

Not measured: concurrent authoring/workflow load during save timing, the extra fsync
of the filesystem's `.applied` note (fix wave 7), and native resource sizing on
constrained machines. The routed-save median check in `save-latency.test.ts`
(20 samples) runs in the default suite.

Unified engine save-result support lands with in-place file/source saves before its tabs. The
engine-result/recovery guarantee must be complete when those tabs claim source history; it does
not block initial chat. Do not claim retroactive evidence for source saves before
provenance support.

Use real Artifact transactions and real durable ModuleStore adapters for parallel
stale saves, revoke-before-commit, rollback and restart tests. Fakes are useful
for authoring UI/proposal cases, not proof of storage serialization. Run the
ModuleStore conformance suite, parser/package fixture tests, actual Gateway
WebSocket stream tests, and native resource/relay tests in their owning features.

For each change run targeted tests and required checks, then `bun run validate`
and the affected build/test tasks before acceptance. Packages keep tests in
`src/test/`; Works uses `test/`. Keep native/credentialed integration journeys
separate from default tests. An Electron smoke must verify actual dependency
loading and sandbox behavior; simulated events do not establish native acceptance.

Phase one is complete only after chat save/build/preview, core fixture file editing,
reactive theme mode, scoped workflow execution, durable data/Grants, and retained
correlated audit views pass those journeys. No self-assigned architecture score
substitutes for them. [Phase two](PHASE-TWO.md) and [Phase three](PHASE-THREE.md)
remain separately planned work.
