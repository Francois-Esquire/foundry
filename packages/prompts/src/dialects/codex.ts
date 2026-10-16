import { Dialect } from "../dialect";
import { notation } from "../notation";

/** Built-in slash commands, a snapshot of the `/` popup. A `command` prompt source extends it. */
const COMMANDS: readonly string[] = [
  "agents",
  "archive",
  "clear",
  "compact",
  "copy",
  "diff",
  "exit",
  "export",
  "feedback",
  "fork",
  "goal",
  "hooks",
  "import",
  "init",
  "keymap",
  "mcp",
  "mention",
  "model",
  "new",
  "permissions",
  "plugins",
  "quit",
  "recap",
  "rename",
  "review",
  "side",
  "skills",
  "status",
  "statusline",
  "subagents",
  "theme",
  "title",
  "usage",
  "vim",
  "voice",
  "worktree",
];

/**
 * Codex CLI. A skill is mentioned with `$name` (`$plugin:skill` under a
 * plugin) anywhere in the message. A custom prompt in `~/.codex/prompts` is
 * invoked as `/prompts:name`, with `$1`..`$9`, `$ARGUMENTS`, and uppercase
 * `$NAME` placeholders filled from `KEY=value` arguments; `$$` writes a
 * literal `$`. `@path` mentions a file. A message that opens with `!` is run
 * in the shell. Codex has no explicit subagent mention.
 */
export const codex = new Dialect({
  id: "codex",
  known: { command: COMMANDS },
  label: "Codex",
  notations: [
    notation.escape({ id: "codex/escape", sequence: "$$" }),
    notation.invocation({
      id: "codex/template",
      kind: "template",
      position: "start",
      sigil: "/prompts:",
    }),
    notation.invocation({
      id: "codex/command",
      kind: "command",
      position: "start",
      sigil: "/",
    }),
    notation.mention({ id: "codex/file" }),
    notation.placeholder({
      forms: ["all", "indexed", "positional", "named-upper"],
      id: "codex/argument",
    }),
    notation.invocation({ id: "codex/skill", kind: "skill", sigil: "$" }),
    notation.shellLine({ id: "codex/shell" }),
  ],
});
