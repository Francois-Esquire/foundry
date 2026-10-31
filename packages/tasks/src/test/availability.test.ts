import { describe, expect, test } from "vitest";
import { deriveAvailability } from "../availability";
import type { Task, TaskDependency, TaskStatus } from "../types";
import { taskId } from "../types";

const AT = "2026-10-29T00:00:00.000Z";

function task(
  id: string,
  status: TaskStatus = "open",
  parentId: string | null = null
): Task {
  return {
    createdAt: AT,
    description: null,
    id: taskId(id),
    metadata: {},
    parentId: parentId === null ? null : taskId(parentId),
    settledAt: null,
    status,
    tags: [],
    title: id,
    updatedAt: AT,
  };
}

function edge(from: string, to: string): TaskDependency {
  return { dependsOnId: taskId(to), taskId: taskId(from) };
}

describe("deriveAvailability", () => {
  test("a dependency blocks until its target settles either way", () => {
    const tasks = [
      task("done", "completed"),
      task("dropped", "cancelled"),
      task("pending"),
      task("waits"),
    ];
    const dependencies = [
      edge("waits", "done"),
      edge("waits", "dropped"),
      edge("waits", "pending"),
    ];
    const result = deriveAvailability({ dependencies, tasks });
    expect(result.get(taskId("waits"))).toEqual({
      blockedBy: [taskId("pending")],
      kind: "blocked",
      waitingOn: [],
    });
    expect(result.get(taskId("pending"))).toEqual({ kind: "ready" });
    expect(result.get(taskId("done"))).toEqual({
      kind: "settled",
      status: "completed",
    });
  });

  test("a dependency on a task missing from the snapshot cannot block", () => {
    const result = deriveAvailability({
      dependencies: [edge("a", "gone")],
      tasks: [task("a")],
    });
    expect(result.get(taskId("a"))).toEqual({ kind: "ready" });
  });

  test("the parent gate lists open ancestors nearest first and ignores started ones", () => {
    const tasks = [
      task("root"),
      task("mid", "active", "root"),
      task("leaf", "open", "mid"),
      task("under-open", "open", "root"),
    ];
    const off = deriveAvailability({ dependencies: [], tasks });
    expect(off.get(taskId("leaf"))).toEqual({ kind: "ready" });

    const on = deriveAvailability(
      { dependencies: [], tasks },
      { parentGate: true }
    );
    expect(on.get(taskId("leaf"))).toEqual({
      blockedBy: [],
      kind: "blocked",
      waitingOn: [taskId("root")],
    });
    expect(on.get(taskId("under-open"))?.kind).toBe("blocked");
    expect(on.get(taskId("mid"))).toEqual({ kind: "active" });
  });
});
