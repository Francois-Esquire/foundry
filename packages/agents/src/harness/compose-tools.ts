import type { ToolSet } from "ai";

export function composeTools(...groups: (ToolSet | undefined)[]): ToolSet {
  const tools: ToolSet = {};
  for (const group of groups) {
    for (const [name, tool] of Object.entries(group ?? {})) {
      if (Object.hasOwn(tools, name)) {
        throw new Error(`Duplicate tool binding: ${name}`);
      }
      tools[name] = tool;
    }
  }
  return tools;
}
