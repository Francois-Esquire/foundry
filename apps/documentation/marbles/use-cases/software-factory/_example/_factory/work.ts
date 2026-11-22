import { tasks } from "@foundry.sh/marbles";
import { z } from "zod";

export const workInput = z.object({ task: z.string() });
export const changeInput = workInput.extend({
  branch: z.string(),
  commit: z.string(),
});

export async function brief(id: string): Promise<string> {
  const task = await tasks.get(id);
  if (!task) {
    throw new Error(`Task ${id} no longer exists.`);
  }
  const { findings } = task.metadata;
  return [
    `# ${task.title}`,
    task.description ?? "",
    typeof findings === "string" ? `## Findings to address\n\n${findings}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
