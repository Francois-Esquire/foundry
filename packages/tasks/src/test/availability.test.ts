import { describe, expect, test } from "vitest";
import {
  availabilityIn,
  deriveAvailability,
  readyTaskIds,
} from "../availability";
import type { TaskSnapshot } from "../store";
import type { Task, TaskDependency, TaskStatus } from "../types";
import { TASK_STATUSES, taskId } from "../types";

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

/** A small deterministic generator, so a failing shape reproduces. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Parents chosen anywhere (cycles and missing ids included), statuses mixed. */
function shuffledSnapshot(seed: number, size: number): TaskSnapshot {
  const next = sequence(seed);
  const pick = (count: number) => Math.floor(next() * count);
  const tasks = Array.from({ length: size }, (_, index) => {
    const roll = next();
    let parent: string | null = null;
    if (roll < 0.7) {
      parent = `t${String(pick(size))}`;
    } else if (roll < 0.75) {
      parent = "missing";
    }
    return task(
      `t${String(index)}`,
      TASK_STATUSES[pick(TASK_STATUSES.length)],
      parent
    );
  });
  const dependencies = Array.from({ length: size }, () =>
    edge(`t${String(pick(size))}`, `t${String(pick(size))}`)
  );
  return { dependencies, tasks };
}

describe("single-task and ready reads", () => {
  test.each([false, true])(
    "agree with the full derivation (parent gate %s)",
    (parentGate) => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const snapshot = shuffledSnapshot(seed, 1 + (seed % 12));
        const full = deriveAvailability(snapshot, { parentGate });
        const ready = [...full]
          .filter(([, availability]) => availability.kind === "ready")
          .map(([id]) => id);

        expect([...readyTaskIds(snapshot, { parentGate })].sort()).toEqual(
          ready.sort()
        );
        for (const { id } of snapshot.tasks) {
          expect(availabilityIn(snapshot, id, { parentGate })).toEqual(
            full.get(id)
          );
        }
        expect(
          availabilityIn(snapshot, taskId("absent"), { parentGate })
        ).toBeNull();
      }
    }
  );

  test("a parent cycle holds back a member only for another open member", () => {
    const snapshot = {
      dependencies: [],
      tasks: [
        task("a", "open", "c"),
        task("b", "active", "a"),
        task("c", "active", "b"),
        task("below", "open", "c"),
      ],
    };
    const ready = readyTaskIds(snapshot, { parentGate: true });
    expect([...ready]).toEqual([taskId("a")]);
    expect(
      availabilityIn(snapshot, taskId("below"), { parentGate: true })
    ).toEqual({ blockedBy: [], kind: "blocked", waitingOn: [taskId("a")] });
  });

  test("a deep chain of open tasks is walked once, not once per task", () => {
    const depth = 20_000;
    const tasks = Array.from({ length: depth }, (_, index) =>
      task(
        `t${String(index)}`,
        "open",
        index === 0 ? null : `t${String(index - 1)}`
      )
    );
    const snapshot = { dependencies: [], tasks };

    expect([...readyTaskIds(snapshot, { parentGate: true })]).toEqual([
      taskId("t0"),
    ]);
    const leaf = availabilityIn(snapshot, taskId(`t${String(depth - 1)}`), {
      parentGate: true,
    });
    expect(leaf?.kind === "blocked" && leaf.waitingOn.length).toBe(depth - 1);
  });
});
