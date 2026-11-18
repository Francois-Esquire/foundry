import { Dialect } from "../dialect";
import { notation } from "../notation";

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
