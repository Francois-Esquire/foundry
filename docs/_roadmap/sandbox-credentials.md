# Agent credentials in sandboxes

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

An agent CLI in a sandbox needs to authenticate to its model provider and
keep its own working state, such as session transcripts and settings. The
host's configuration can't simply be shared. A host login may live in an OS
keychain that doesn't exist in the VM, a read-only copy can't hold the state
the CLI writes, and mounting a home folder exposes more than the agent
needs.

- Credentials are supplied per run, explicitly. Nothing is inherited from
  the host environment by accident.
- The CLI gets a writable config and state directory inside the sandbox,
  kept or discarded per run as the workflow decides.
- Credentials stay out of logs, and out of the agent's own environment where
  that can be avoided.

Done means a fresh sandbox can run an authenticated agent with nothing
mounted from the host's home directory.

## Opinion: how to build it

- Updated user direction, 2026-10-03: Claude Code uses the existing Claude
  subscription login. The host supplies a current access token to the guest
  CLI, while keeping refresh credentials in the host credential store. Do not
  require an Anthropic API key or mount the host login/config directory.
- Codex can use its host subscription through app-server external auth tokens.
  Explicit API credentials remain an optional host choice, not a prerequisite.
- Later: assess an egress credential proxy where supported.
- Set `CLAUDE_CONFIG_DIR` for Claude Code, or `CODEX_HOME` for Codex, to a
  writable path inside the sandbox. Use a named volume when sessions must
  resume across runs.
- Stop mounting the host's `~/.claude` and `~/.codex` read-only. On a Mac,
  Claude Code keeps its login in the Keychain, so the mount carries settings
  but no login, and the CLI can't write its state there. If host skills or
  settings are wanted, copy those specific files in.
- Forward only an allow list of environment variables to sandboxed
  processes, never the host environment as a whole.

Authentication references: [Claude Code authentication](https://code.claude.com/docs/en/authentication)
and [Agent SDK subscription usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
