# Claude Code in a sandbox

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

Claude Code should run with its own tools, but with every command and file
change happening inside an isolated VM instead of on the host. Control stays
on the host: approvals, hooks, records, and the session's lifecycle.

- The VM sees only the workspace it was given and the network destinations
  it needs.
- The host's credentials and environment don't reach the VM, except what the
  run passes on purpose.
- Stopping the run stops the process in the VM.

Done means a workflow step runs Claude Code against a mounted workspace in a
VM, approvals behave as they do on the host, and nothing runs on the host
except the controlling process.

## Opinion: how to build it

Split the process. The Claude Agent SDK stays on the host, and only the
`claude` CLI runs in the VM.

- The SDK's `spawnClaudeCodeProcess` setting replaces how the CLI is
  started, and is intended for VMs, containers, and remote environments.
  The Claude Code AI SDK provider accepts it as a setting.
- Return a sandbox process with piped stdin and stdout. The SDK runs its
  control protocol over that pipe, so approval callbacks, hooks, in-process
  MCP servers, and message callbacks keep running on the host unchanged.
- The command the SDK passes points at the host's own binary, which on a Mac
  is a macOS build. Ignore it and run the VM's Linux `claude` instead. Build
  an image with Claude Code installed, and version it alongside the SDK.
- Filter the environment the SDK passes before forwarding it: the model
  credential and the variables Claude Code needs, nothing else.
- Point Claude Code's config directory at a writable path in the VM.
- What this needs from the sandbox:
  - outbound HTTPS to the model API;
  - a long-lived process with separate piped stdin, stdout, and stderr;
  - a way to pass credentials;
  - a workspace mount that allows running project tools.
- Codex's app-server also speaks over stdio, so the same split works if the
  Codex provider allows a custom spawn. That hasn't been checked yet.
