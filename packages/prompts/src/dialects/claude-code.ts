import { Dialect } from "../dialect";
import { notation } from "../notation";

/** Built-in slash commands, a snapshot of the `/` menu. A `command` prompt source extends it. */
const COMMANDS: readonly string[] = [
  "add-dir",
  "agents",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "fast",
  "help",
  "hooks",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "permissions",
  "plugin",
  "pr-comments",
  "resume",
  "review",
  "rewind",
  "status",
  "terminal-setup",
  "usage",
  "vim",
];

/** Values Claude Code substitutes inside a skill or command file. */
const VARIABLES: readonly string[] = [
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_SESSION_ID",
  "CLAUDE_SKILL_DIR",
];

/**
 * Claude Code. Skills and commands share the `/` sigil; a built-in name that
 * opens the message is a command, anything else is a skill. `@path` mentions
 * a file, `@"name (agent)"` a subagent. Inside a skill or command file,
 * `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, and `$name` are filled from the
 * invocation, `${CLAUDE_SKILL_DIR}` from the harness, and `` !`cmd` `` from
 * the shell.
 */
export const claudeCode = new Dialect({
  id: "claude-code",
  known: { command: COMMANDS, variable: VARIABLES },
  label: "Claude Code",
  notations: [
    notation.invocation({
      id: "claude-code/command",
      kind: "command",
      known: true,
      position: "start",
      sigil: "/",
    }),
    notation.invocation({ id: "claude-code/skill", kind: "skill", sigil: "/" }),
    notation.agentMention({ id: "claude-code/agent" }),
    notation.mention({ id: "claude-code/file" }),
    notation.variable({ id: "claude-code/variable" }),
    notation.placeholder({
      forms: ["all", "indexed", "positional", "named"],
      id: "claude-code/argument",
    }),
    notation.inlineShell({ id: "claude-code/shell" }),
  ],
});
