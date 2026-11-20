import type { TaskDependency } from "./schema";

export function edgeKey(edge: TaskDependency): string {
  return JSON.stringify([edge.taskId, edge.dependsOnId]);
}
