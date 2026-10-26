---
title: Deployment targets
description: Where Marbles should run, what each target needs, and the seams that get it there.
sidebar:
  label: Deployment targets
---

Marbles runs today as one process per machine, hosting each workspace in a
worker, driven from a terminal. The goal is to deliver the same engine as a
service: on a container host, as a library inside a serverless backend, and
behind a network protocol that dashboards, MCP clients, and other systems
can reach. This page records the targets, the current position, and the
solutions, so each step is taken against one picture.

## Goals

- **One engine, several drivers.** The lib defines steps, workflows,
  triggers, runs, and sessions once. A driver decides where state lives,
  what ticks the schedules, and where agents execute. The CLI and daemon
  are one driver; a serverless backend is another.
- **A service, not only a tool.** Reachable over a network with
  authentication, a health endpoint, and structured logs, so it can run
  unattended under an operator.
- **Headless by default.** Everything the dashboard can do is available
  without a terminal, and anything that asks a person can wait for an
  answer that arrives later over the wire.
- **Parameterized, opinionated locations.** Every path, store, and
  executor has a default and an override, so the same build runs on a
  laptop, in a container with a volume, or against tables in a hosted
  database.
- **Sandboxes as a backend choice.** Isolation and long-running agent
  compute come from a pluggable sandbox: a local microVM, a hosted sandbox
  such as Vercel Sandbox, or a remote sandbox service of our own.

## Targets

| Target | Class | What hosts the engine |
| --- | --- | --- |
| Plain image (Docker, a VM) | Container | The daemon, with a volume at `FOUNDRY_HOME` |
| Railway, Render | Container | The daemon, with the platform's persistent disk |
| Cloudflare Containers | Container | The daemon; disk is ephemeral, so state needs R2 or a snapshot |
| Cloudflare Workers | Isolate | Cannot host the engine; a gateway in front of a container, or a client |
| Convex | Isolate plus Node actions | The lib, driven by cron and backed by tables; agents execute remotely |

Container targets can run the daemon now once a few gaps close. Isolate
targets cannot run a long-lived process, spawn children, open a Unix
socket, or keep filesystem state, so they take the library profile.

## Where things stand

What already supports these targets:

- Headless operation exists. A non-terminal `marbles run` attaches and
  streams; `marbles daemon` runs in the foreground for systemd or launchd;
  SIGTERM drains; the daemon re-hosts every workspace marked `hosted` on
  restart.
- The scheduler is externally drivable. `tick()` takes an injected clock,
  signal, and scheduled flag; the loop takes an injected sleep. Monitors
  record what they last saw in the state store, so a poll in another
  process works.
- Storage is partly an interface. `StateStore` (schedules, monitors,
  automations) has JSON and in-memory implementations. `@foundry/workflows`
  ships `ExecutionCoordinator` over `ExecutionRepository` and `RunJournal`
  contracts for runs, suspensions, queues, and frames.
- Sandboxes are injected. The engine takes `containers` as a value or a
  factory, and `@foundry/sandbox` defines the files, commands, processes,
  and ports facets a backend implements.
- The wire protocol is one step from JSON-RPC: id, method, params, result,
  error, and id-less notifications over a `Transport` interface. Methods
  are namespaced `workspace.*`.
- Every location is parameterized through `layout()`: `FOUNDRY_HOME`,
  `--state`, `--artifacts`.

What blocks them:

- No network surface. The only transports are a `0o600` Unix socket and
  stdio MCP. There is no HTTP, WebSocket, authentication, or health
  endpoint.
- Nothing to host at boot. `marbles daemon` takes no source, so a fresh
  container has no workspace until a client attaches one.
- Run persistence is hard-wired. The engine builds an in-memory
  orchestrator store hydrated from run files on disk, and writes run files
  plus the run extras (ledger, session, literals) itself. There is no
  option to supply a store.
- Run ownership lives in memory. Held runs, run scopes, and queue
  concurrency assume one long-lived instance owns active runs.
- Construction is node-bound. The engine wires the node file observer, git,
  and home and temp directories unconditionally. The workspace bucket is
  host-side by design: the Bun plugin loader, Varlock spawn, and source
  watching load authoring files from disk.
- Lock liveness is pid-only. Locks record a pid and check it with a zero
  signal; in a container, pids restart low, so a stale lock on a volume can
  look alive.
- Credentials are host-login shaped. Codex reads `~/.codex/auth.json`,
  Claude reads the macOS keychain with `CLAUDE_CODE_OAUTH_TOKEN` as the one
  environment route, and Varlock must be on the image.
- Sandboxes need a hypervisor. The microVM backend needs nested
  virtualization, which container hosts do not give; the in-memory
  backend cannot run a real CLI. Agent steps that use a sandbox fail on
  those hosts.
- Duration. A tick launches its run and awaits it in-process. Serverless
  invocations are capped (Convex Node actions: ten minutes, 512 MB), and a
  harness turn mid-CLI cannot be suspended, so a long agent step cannot
  finish inside one invocation.
- Logging is lines. One module uses structured logging; everything else
  prints.

## Solutions

### Protocol: JSON-RPC 2.0 over any transport

Adopt JSON-RPC 2.0 framing in the process protocol: the `jsonrpc` field,
string or number ids, and `code`, `message`, `data` errors. The change is
confined to the protocol and channel modules; the `Transport` interface
carries it over the Unix socket, a WebSocket, or HTTP unchanged. MCP is
JSON-RPC 2.0, so one framing serves the daemon and the MCP server.

Plain HTTP loses the server-to-client direction that carries status lines
and workspace state. Mirror MCP Streamable HTTP: POST for requests, a
server-sent event stream for notifications. A WebSocket transport is the
other option for the daemon.

### Service surface: HTTP, auth, health, logs

Add an HTTP listener beside the socket with a bearer token, a health
endpoint that reports the daemon and each worker, and MCP over Streamable
HTTP as a second binding of the same server. Move printed lines to
structured events with a line renderer for terminals.

### Boot: attach at start

`marbles daemon --attach <source>` (repeatable), plus an environment
variable form for images, so a container hosts its workspace with no
client call. Keep the `hosted` record as the restart path.

### State: open the run store seam

Accept an `OrchestratorStore` on the engine options and give the run
extras a home in it, defaulting to the in-memory store hydrated from run
files. A durable implementation then supplies `ExecutionRepository` and
`RunJournal`. Implement `StateStore` for the same backend. Convex tables are
the first proof; a SQL backend is the second.

Rebuild run ownership from the store on start, so an engine constructed
cold for one tick adopts held runs and scopes the way a restarted daemon
does today.

### Locks that survive a container restart

Record a start time or boot id beside the pid in process and lock files,
and treat a pid whose start time does not match as stale.

### Credentials from the environment

An environment route for every harness: Claude through the existing token
variable, Codex through access token and account id variables, Pi through
its own auth. Document the image contract: which variables, and Varlock on
the image.

### Sandboxes: a backend per host

Three backends behind the same facets: the local microVM for machines with
a hypervisor, a hosted sandbox (Vercel Sandbox) for container and
serverless hosts, and a remote sandbox service of our own exposing the same
facets over the same JSON-RPC. In the serverless profile the sandbox is
also the long-running compute: an agent step hands off to it and later
ticks poll it. Guest auth injects subscription tokens into the guest, so a
third-party backend is a decision about where those tokens may go.

### Two drivers over one lib

- **VM driver.** Today's daemon and workers, with the service surface
  above. One replica per state root, by design.
- **Serverless driver (Convex first).** The deployment imports the lib and
  defines its steps statically, so the workspace bucket is not involved.
  A cron calls `tick()` per schedule; tables implement the state store and
  the run store; HTTP monitors only; agent steps hand off to a remote
  sandbox; dashboards and MCP clients speak JSON-RPC over HTTP. Workers on
  Cloudflare are a gateway or a client in front of either driver.

### Packaging

A Dockerfile that builds the app, installs the harness CLIs and Varlock,
sets `FOUNDRY_HOME` to a volume, and runs `marbles daemon --attach`.
Platform notes for Railway, Render, and Cloudflare Containers follow from
it.

## Order

1. JSON-RPC 2.0 framing, then an HTTP transport with a token and a health
   endpoint, and MCP over Streamable HTTP.
2. Boot-time attach, lock liveness, environment credentials, a Dockerfile.
   This makes the container targets real.
3. The run store seam and cold-start ownership, with Convex adapters as
   the proof.
4. A hosted sandbox backend, then the remote sandbox service.
5. Structured logs throughout.
