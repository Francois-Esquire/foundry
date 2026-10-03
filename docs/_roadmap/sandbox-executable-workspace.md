# Running project tools in a sandbox workspace

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

A coding agent runs the project's own tools: `npm test`, `bun run build`,
scripts in the repository, binaries installed into `node_modules/.bin`.
Workspace mounts are `noexec`, so anything executed directly from the
workspace fails with a permission error. Only commands run through an
interpreter, such as `sh script.sh` or `node file.js`, work.

Programs in the workspace should be executable inside the sandbox, while the
sandbox still keeps the host safe.

Done means an agent can install dependencies and run the project's test and
build scripts in a sandboxed workspace.

## Opinion: how to build it

- Allow exec on the workspace mount, and keep `nosuid` and `nodev`. The VM
  is the security boundary. `noexec` only stops the guest from running
  workspace files; it doesn't stop the guest writing files the host later
  runs. So it costs the agent a lot and protects the host little.
- Keep config and credential mounts read-only and `noexec`.
- If the shared workspace is still a concern, the alternative is copying
  the workspace onto the VM's disk and syncing changes back. That isolates
  more but is slower and needs conflict handling. Start with exec on the
  mount.
