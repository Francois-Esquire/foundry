import type { TokenKind } from "./parser";

export const HIGHLIGHT_SCOPES: Readonly<Record<TokenKind, string>> = {
  agent: "entity.name.tag.agent.prompt",
  argument: "variable.parameter.argument.prompt",
  command: "keyword.control.command.prompt",
  escape: "constant.character.escape.prompt",
  file: "support.type.path.prompt",
  hole: "meta.embedded.expression.prompt",
  mcp: "entity.name.tag.mcp.prompt",
  shell: "keyword.other.shell.prompt",
  skill: "entity.name.function.skill.prompt",
  template: "entity.name.function.template.prompt",
  text: "text.prompt",
  variable: "variable.other.constant.environment.prompt",
};
