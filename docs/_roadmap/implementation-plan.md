# Sandbox and harness implementation

Status: implementation and verification in progress. Governing input: the ten
roadmap notes in this directory and the accepted host-composition design.

The execution runtime is MicroSandbox. It consumes Linux OCI base images
directly. No Docker or Podman daemon, CLI, builder, Dockerfile, or alternate
runtime is part of this work. Guest preparation installs pinned native CLI
binaries before a coding turn. Snapshots are not a prerequisite.

## Ownership and dependencies

Three GPT-6.1 Sol workers share this branch with explicit ownership:

- Sandbox worker: generic piped processes, executable mounts, native network
  enforcement, lifecycle and VM tests. Owns `packages/sandbox`.
- Agents worker: neutral turn/session contract, authorization, records, and
  built-in coding loop. Owns `packages/agents`, then Quirks coding tools.
- CLI worker: Claude transport through the existing community provider and the
  smallest Codex app-server transport needed for injected process launching.
  Owns `packages/models` CLI adapters and native protocol tests.
- Coordinating host: Quirks composition, guest preparation, subscription credentials,
  integration fixtures, packaging, and this evidence record.

Process launch is the dependency between Sandbox and CLI adapters. The neutral
turn driver is the dependency between Agents and CLI adapters. Quirks composes
all three after those contracts agree. Agents does not import Sandbox. Workers
coordinate overlapping signatures before changing them.

## Roadmap correspondence

| Roadmap | Implementation and acceptance |
| --- | --- |
| harness-permissions | Explicit scheduled/attended profiles, native Claude settings and Codex sandbox/approval settings first; no migration prerequisite. Built-in tools use existing authorization. Unsupported native policy restrictions must fail closed. |
| harness-visibility | Normalized tool attempts/outcomes/refusals enter the existing session transcript and Quirks stream. Inputs are summarized without arbitrary argument values. |
| harness-approvals | Native live callbacks use Agents authorization and grants. Scheduled requests are recorded and denied; attended callbacks remain in process and abortable. They never call Quirks workflow suspension. |
| sandbox-network | Default-denied egress and native exact hostname/port allowlists. Strict HTTPS hostname enforcement requires native TLS interception with upstream verification. Destination decision logging remains unverified/unavailable in observed SDK logs. |
| sandbox-processes | Non-TTY byte streams, writable stdin, separate stdout/stderr, Node-shaped lifecycle and a deferred synchronous launch bridge. Abort covers launch and execution. |
| sandbox-credentials | Host supplies the selected subscription access token per session; explicit API credentials remain optional. No automatic host home/login mounts. Writable CLI state is isolated by session ID. Secret env is not stored in sandbox constraints or session records. |
| sandbox-executable-workspace | Opt-in executable workspace mounts retain nosuid/nodev; default remains noexec. |
| claude-code-in-sandbox | Host SDK controls pinned native Linux CLI in MicroSandbox. Preparation verifies npm integrity and CLI version. SDK callbacks remain in the host. |
| harness-layer | Agents owns the common interface and durable native-session mapping. Concrete CLI adapters remain in Models as an incremental compatibility location; old language-model exports remain available. Full extraction is not claimed. |
| builtin-coding-harness | Existing loop plus coding instructions, explicit step limit, compaction and Sandbox toolkit. OpenAI-compatible gateway path is reused, including for OpenRouter configuration. |

## Verification

Deterministic tests run without credentials. VM/protocol tests and authenticated
provider tests are separate integration commands. Missing prerequisites fail
explicitly. A filtered run proves only its selected cases.

The shared coding fixture starts with a failing Bun test. The harness must edit
the source inside MicroSandbox and run the test; the host verifies the resulting
file and test independently. Policy tests assert a refused effect never runs.
Process tests check byte preservation, EOF, backpressure, launch cancellation,
nonzero exit, process reaping and cleanup. Sessions must not inherit another
session's keys, working directory, grants or subscribers.

Commands:

- `bun run --cwd packages/agents test`
- `bun run --cwd packages/models test`
- `bun run --cwd packages/sandbox test`
- `bun run --cwd packages/sandbox test:integration`
- `bun run --cwd apps/quirks test:unit`
- `bun run --cwd apps/quirks test:integration`
- `bun run env:run -- bun run --cwd apps/quirks test:integration test/sandbox/provider.integration.test.ts`
- `bun run --cwd apps/quirks test:package`
- `bun run validate`

## Verification record — 2026-10-03

- `bun run validate`: passed repository lint/format, dependency consistency,
  all 22 Turbo build/typecheck tasks, and dead-code checks.
- Agents: all 417 tests passed, including compaction after a completed turn,
  live/deferred approvals, grant claims, transcript ordering and shutdown.
- Models: all 443 unit tests passed; CLI adapter focused checks passed.
- Sandbox: all 121 unit tests passed. The full native integration run passed
  18 tests and failed three WebSocket close tests. Credential-free probes using
  only the native SDK reproduced missing TCP EOF and WebSocket close completion,
  with the SDK's bundled msb 0.6.18. No Foundry workaround or runtime switch was
  added. See `packages/sandbox/README.md` for the evidence.
- Quirks: 247 unit tests, 68 terminal tests, and two standalone package-consumer
  tests passed. The library and CLI continue sharing the packed registry.
- Live coding: built-in through AI Gateway and Claude Code through the user's
  Max subscription each repaired the fixture and passed Bun tests inside
  MicroSandbox. The latest combined run passed both selected cases.
- Native CLI integration: both pinned Linux CLIs passed credential-free protocol
  initialization. Codex also executed a sandboxed command and refused a write
  under read-only policy, with the target independently verified absent.
- Codex subscription coding passed after the user explicitly authorized its
  access token/account ID transfer. The selected live test passed in 49.65s
  with `OPENAI_API_KEY` removed from the process environment. Codex repaired
  the fixture inside MicroSandbox; an independent Bun test run and file check
  confirmed the fix. Refresh credentials stayed on the host. All three
  harnesses have now passed their live coding fixtures.
- Claude's API-key-only assumption was superseded by the user's subscription
  instruction. The host retains refresh credentials; only the current access
  token goes to the guest. Optional `CLAUDE_CODE_OAUTH_TOKEN` is declared sensitive
  in Varlock. Codex supports the app-server external subscription-token flow.

## Interactive follow-up

Checkpoint `1ef0f4f` preserves the initial implementation. The follow-up adds
provider-neutral questions, a host feed bridge, persistent authority grants,
and live-input attention in the dashboard. The host bridge keeps attended
turns alive; it never calls workflow suspension. Deferred requests write
future grants, and recorded sessions reconcile interrupted feed publication.

The final combined authenticated MicroSandbox interactive run passed all
three harnesses in 144.71 seconds. Each scenario used the real Quirks engine,
agent manager, feed publisher/reader and `Engine.answer` route to:

- ask for a random marker unknown to the model before the feed answer;
- block a shell write until approval and verify the file was absent first;
- recall the answer on a second turn in the same session, with another approval;
- deny a later command and independently verify its file was never created;
- cancel while a question waited, reject a stale answer, and verify the step
  body ran once without workflow replay.

Claude uses its native `AskUserQuestion`. Codex's ordinary coding mode uses the
shared `ask_user` dynamic tool; native app-server `requestUserInput` mapping is
covered by protocol tests, not a live plan-mode fixture. Both CLI processes ran
inside MicroSandbox using subscriptions. The built-in loop ran on the host
with its coding tools inside MicroSandbox. Tests supply deterministic feed
answers through the same route as the dashboard; OpenTUI render tests separately
verify attention labels and retained pause/steer/cancel controls.

Additional tests cover free-text and multiple answers, declines, remembered
session grants, durable future grants with both stores reopened, agent isolation,
competing claims, late answers, shutdown during publication, and recovery of
missing request indexes or failed answered-feed writes. Question telemetry
records counts/outcomes, while the user-facing feed and model history retain
question/answer content. Approval previews show the full redacted operation.

## Activities and durable automation follow-up

Agents now owns a provider-neutral activity contract and persistent session
events. Models translates native CLI events. Quirks projects those events into
the run tree, routes child questions and approvals through the existing feed,
and exposes stop only when the owning adapter can perform it. Activities retain
their session and native identities; they do not become synthetic workflow steps.
Reopened activity projections show unknown state until the current connection
reports that activity; attaching a session alone does not revive stale controls.

Every sandbox harness receives bounded host delegation and approved automation
tools. Delegated children inherit the same MicroSandbox, model and authority,
with their own session, approval ownership and automation records. The host
persists declarative schedules and file/HTTP monitors and executes them through
the existing scheduler and monitor delivery protocol. The first deadline survives
restart. New triggers become visible to an already running loop. Pause and delete
affect future firings, and dashboard controls expose those operations. Recovered
invalid definitions are disabled with diagnostics. HTTP destinations require
host authorization and redirects are refused. Recreating a deleted automation
key produces a fresh ID, isolating it from old pending launches and run history.

Current local verification passed 429 Agents tests, 456 Models tests, 277 Quirks
unit tests, 74 terminal tests and two standalone package-consumer tests. Quirks
build and repository validation passed, including all 22 Turbo build/typecheck
tasks. The terminal suite includes actual CLI startup, cancellation and shutdown;
it caught and now covers a duplicate cancellation race between scheduler shutdown
and engine shutdown. Additional regressions cover native child cancellation while
input is pending, confirmed native completion, stale activity controls after
restart, and deleted automation keys being recreated. Interactive MicroSandbox
regression scenarios passed for all three harnesses after the persistent Codex
transport change.

The final authenticated activity integration run passed all three harnesses in
126.62 seconds. Each harness delegated a child question through the real feed
and `Engine.answer`, returned its random answer, and created a host schedule.
The test reopened persisted automation state, fired its real target workflow,
independently checked its output file, and paused and deleted the trigger.
Claude and Codex additionally launched native foreground subagents, routed their
shell approvals with native child identity, copied an unknown random marker
through a guest shell command, and reported confirmed native completion. The
fixture independently verified the resulting file. CLI authentication used the
existing subscriptions with both API-key environment variables removed.

Native Monitor/Cron translation, idle Codex child events and native child stop
have protocol-level tests. Claude's provider currently closes its query after the
parent result, so detached Claude activity cannot remain continuously observed.
Native Claude questions carry child identity; its generic MCP bridge does not
expose enough correlation to attribute arbitrary native-child shared `ask_user`
calls. Native schedules remain CLI-owned and are not silently promoted into host
automation. Monitor delivery retains the existing crash window between launch
and acknowledgement, so it does not promise exactly-once delivery. Pi is deferred.

## Remaining acceptance limits

- Native destination-level allowed/refused network logs remain unavailable in
  observed SDK system logs. Enforcement has been tested; an audit log is not
  being fabricated from configured rules.
- The three native WebSocket-close regressions keep the full integration suite
  from passing, despite successful message exchange and process stdio tests.
- Native CLI history resumes only in the same guest generation. A replaced VM
  produces an actionable refusal; named persistent state is not implemented.
- Concrete CLI adapters and legacy language-model compatibility routes remain
  in Models. New profiles/authority require a sandbox session and are never
  silently ignored on the legacy path.
- Codex rejects native deny patterns it cannot enforce before launching; its
  step cap interrupts based on observed tool starts rather than a native turn
  limit. CLI adapter input is currently text-only.
- Native signaled exits can report -1 without signal metadata; this status is
  preserved rather than replaced with an invented Unix exit code.

The roadmap is not marked complete while these acceptance limits remain.
