import { Dialect } from "../dialect";
import { notation } from "../notation";

/** Built-in slash commands, a snapshot. Any other `/name` is a prompt template. */
const COMMANDS: readonly string[] = [
  "changelog",
  "clear",
  "compact",
  "copy",
  "exit",
  "export",
  "fork",
  "hotkeys",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "session",
  "settings",
  "share",
  "tree",
];

/**
 * Pi. `/skill:name [args]` loads a skill; `/name [args]` expands a prompt
 * template unless `name` is a built-in command. Templates fill `$1`, `$2`, …
 * and `$@`. `@path` mentions a file. A message that opens with `!` is run in
 * the shell.
 */
export const pi = new Dialect({
  id: "pi",
  known: { command: COMMANDS },
  label: "Pi",
  notations: [
    notation.invocation({
      id: "pi/skill",
      kind: "skill",
      position: "start",
      sigil: "/skill:",
    }),
    notation.invocation({
      id: "pi/command",
      kind: "command",
      known: true,
      position: "start",
      sigil: "/",
    }),
    notation.invocation({
      id: "pi/template",
      kind: "template",
      position: "start",
      sigil: "/",
    }),
    notation.mention({ id: "pi/file" }),
    notation.placeholder({ forms: ["positional", "rest"], id: "pi/argument" }),
    notation.shellLine({ id: "pi/shell" }),
  ],
});
