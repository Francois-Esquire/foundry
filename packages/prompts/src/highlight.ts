import type { TokenKind } from "./language";

/**
 * A TextMate scope per token kind, for an editor that colours `tokenize()`
 * output. Chosen so stock themes already distinguish the kinds.
 */
export const HIGHLIGHT_SCOPES: Readonly<Record<TokenKind, string>> = {
  agent: "entity.name.tag.agent.prompt",
  argument: "variable.parameter.argument.prompt",
  command: "keyword.control.command.prompt",
  escape: "constant.character.escape.prompt",
  file: "string.unquoted.path.prompt",
  hole: "meta.embedded.expression.prompt",
  mcp: "entity.name.tag.mcp.prompt",
  shell: "meta.embedded.shell.prompt",
  skill: "entity.name.function.skill.prompt",
  template: "entity.name.function.template.prompt",
  text: "text.prompt",
  variable: "variable.other.environment.prompt",
};
