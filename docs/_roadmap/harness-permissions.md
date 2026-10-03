# Explicit permissions for CLI harnesses

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

When Claude Code or Codex runs a turn, the CLI decides for itself whether a
shell command, file edit, or web request may go ahead. Foundry should set
that posture every time, instead of inheriting whatever the installed CLI
does by default or whatever the user's personal configuration says.

A run needs a declared posture:

- which tools are allowed outright;
- which are always refused, such as pushing, publishing, or deleting
  outside the workspace;
- what happens to everything else: ask, or refuse;
- how many steps a turn may take.

Scheduled and attended runs need different postures. Nobody is present to
answer a question during a scheduled run, so it must never wait on one.

Done means the same configuration produces the same permission behavior on
every machine, and none of it depends on undocumented defaults.

## Opinion: how to build it

Pass the posture through provider settings that already exist. No new
machinery is needed.

- Claude Code: set `permissionMode`, `allowedTools`, `disallowedTools`, and
  `maxTurns` explicitly. Scheduled runs use `dontAsk`, which refuses
  anything not on the allow list and never prompts. Attended runs move to
  `default` once approvals are wired; until then, `dontAsk` everywhere. The
  provider already keeps Claude away from user settings files
  (`settingSources: []`), so these lists are the whole rule set.
- Codex: set `approvalPolicy` and `sandboxPolicy` (`workspace-write`)
  explicitly instead of leaving them to the user's Codex configuration.
- Describe the posture once, as a named profile such as `scheduled` or
  `attended`, and translate it per harness.
- Write deny rules as scoped patterns such as `Bash(git push*)`, not bare
  tool names, so the tool stays usable for safe commands.

Today neither harness gets any of this. With no `permissionMode` and no
approval callback, what Claude Code does with a tool that needs permission
is undetermined. Setting it explicitly removes the question.
