import type { TaskDependency } from "./schema";

/** A collision-free map key for one edge; ids may contain any character. */
export function edgeKey(edge: TaskDependency): string {
  return JSON.stringify([edge.taskId, edge.dependsOnId]);
}
