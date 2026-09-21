import type { ToolSet } from "ai";

import { composeTools } from "../tools/compose";

export interface AgentContribution {
  readonly instructions?: string;
  readonly tools?: ToolSet;
}

export async function compose(
  ...parts: readonly (AgentContribution | Promise<AgentContribution>)[]
): Promise<AgentContribution> {
  const contributions = await Promise.all(
    parts.map((part) => Promise.resolve(part))
  );
  return {
    instructions: contributions
      .map(({ instructions }) => instructions?.trim())
      .filter(Boolean)
      .join("\n\n"),
    tools: composeTools(...contributions.map(({ tools }) => tools)),
  };
}
