import type { Page } from "@foundry/core/pagination";
import type {
  Task,
  TaskChangeResult,
  TaskNode,
  TaskRelations,
} from "@foundry/tasks";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/tasks/command";

/** A command's result as lines for a person; `--json` prints the result. */

const INDENT = "  ";

function taskLine(task: Task, depth = 0): string {
  const tags = task.tags.length === 0 ? "" : `  [${task.tags.join(", ")}]`;
  return `${INDENT.repeat(depth)}${task.id}  ${task.status}  ${task.title}${tags}`;
}

function treeLines(nodes: readonly TaskNode[], depth: number): string[] {
  return nodes.flatMap((node) => [
    taskLine(node, depth),
    ...treeLines(node.subtasks ?? [], depth + 1),
  ]);
}

function pageLines(page: Page<TaskNode, number>): string[] {
  if (page.items.length === 0) {
    return [`no tasks (${page.total} matching)`];
  }
  const more =
    page.nextCursor === undefined ? "" : `; next: --cursor ${page.nextCursor}`;
  return [
    ...treeLines(page.items, 0),
    `${page.items.length} shown of ${page.total}${more}`,
  ];
}

function detailLines(task: TaskNode): string[] {
  const lines = [
    taskLine(task),
    `parent: ${task.parentId ?? "none"}`,
    `created: ${task.createdAt}`,
    `updated: ${task.updatedAt}`,
  ];
  if (task.settledAt !== null) {
    lines.push(`settled: ${task.settledAt}`);
  }
  if (task.description !== null) {
    lines.push(`description: ${task.description}`);
  }
  if (Object.keys(task.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(task.metadata)}`);
  }
  if (task.subtasks !== undefined) {
    lines.push(
      task.subtasks.length === 0 ? "subtasks: none" : "subtasks:",
      ...treeLines(task.subtasks, 1)
    );
  }
  return lines;
}

function relationLines({ dependents, dependsOn }: TaskRelations): string[] {
  return [
    dependsOn.length === 0 ? "depends on: nothing" : "depends on:",
    ...dependsOn.map((task) => taskLine(task, 1)),
    dependents.length === 0 ? "dependents: none" : "dependents:",
    ...dependents.map((task) => taskLine(task, 1)),
  ];
}

function changeLines({ changed, tasks }: TaskChangeResult): string[] {
  return tasks.map((task, index) => {
    const key = changed[index]?.key;
    return key === undefined ? taskLine(task) : `${taskLine(task)}  (${key})`;
  });
}

const TEXT: {
  readonly [K in TaskCommandKind]: (result: TaskCommandResult<K>) => string[];
} = {
  change: changeLines,
  dependencies: relationLines,
  get: detailLines,
  list: pageLines,
  ready: pageLines,
};

export function taskCommandText<K extends TaskCommandKind>(
  command: TaskCommand<K>,
  result: TaskCommandResult<K>
): string {
  const text: (result: TaskCommandResult<K>) => string[] = TEXT[command.kind];
  return text(result).join("\n");
}
