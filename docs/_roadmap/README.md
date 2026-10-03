# Roadmap

Maintainer note, excluded from the Blume site. Features we have found we
need, collected 2026-10-03. Each entry stands on its own: what we need,
stated independently of how we build it, then an opinion on how to build it.

Suggested order, smallest and most unblocking first:

1. `harness-permissions.md`: every CLI harness turn runs under a declared
   permission posture.
2. `harness-visibility.md`: every tool call and refusal from a CLI harness
   shows up in the run's record.
3. `harness-approvals.md`: CLI tool calls go through Foundry's own
   authorization.
4. `sandbox-network.md`: sandboxes reach the destinations they need and
   nothing else.
5. `sandbox-processes.md`: a host process can drive a long-lived program in
   a sandbox over piped streams.
6. `sandbox-credentials.md`: agents authenticate in a sandbox without
   borrowing the host's home directory.
7. `sandbox-executable-workspace.md`: project tools run from a sandboxed
   workspace.
8. `claude-code-in-sandbox.md`: Claude Code's tools run in a VM while
   control stays on the host.
9. `harness-layer.md`: the thing that runs a turn is its own layer,
   separate from the model registry.
10. `builtin-coding-harness.md`: a coding agent on any gateway model, with
    no CLI installed.
