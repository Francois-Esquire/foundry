import { describe, expect, test } from "vitest";
import {
  taskDependencySchema,
  taskEventSchema,
  taskSnapshotSchema,
  taskStoreWriteSchema,
} from "../schema";
import type { TaskStoreWrite } from "../store";
import { MemoryTaskStore } from "../store";
import { Tasks } from "../tasks";

const clock = () => new Date("2026-10-29T00:00:00.000Z");

class RecordingStore extends MemoryTaskStore {
  readonly writes: TaskStoreWrite[] = [];

  override commit(write: TaskStoreWrite): Promise<void> {
    this.writes.push(structuredClone(write));
    return super.commit(write);
  }
}

/** Every kind of write: puts, edges both ways, a settle, and a removal. */
async function history(): Promise<RecordingStore> {
  const store = new RecordingStore();
  const tasks = new Tasks({ clock, store });
  const epic = await tasks.create({ tags: ["api"], title: "Epic" });
  const design = await tasks.create(
    { description: "first", title: "Design" },
    { parent: { id: epic.id } }
  );
  const build = await tasks.create(
    { metadata: { size: "m" }, title: "Build" },
    { dependsOn: [{ id: design.id }], parent: { id: epic.id } }
  );
  await tasks.complete(design.id);
  await tasks.update(build.id, { metadata: { size: null } });
  await tasks.remove(build.id);
  return store;
}

describe("record schemas", () => {
  test("every write a store receives parses strictly, unchanged", async () => {
    const store = await history();
    expect(store.writes.some((write) => write.deleteTasks)).toBe(true);
    expect(store.writes.some((write) => write.deleteDependencies)).toBe(true);
    for (const write of store.writes) {
      expect(taskStoreWriteSchema.parse(write)).toEqual(write);
      expect(write.event).toBeDefined();
      expect(taskEventSchema.parse(write.event)).toEqual(write.event);
    }
  });

  test("a snapshot parses strictly, unchanged", async () => {
    const store = await history();
    const snapshot = await store.snapshot();
    expect(snapshot.tasks).toHaveLength(2);
    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("a shape the store does not hold is refused", async () => {
    const store = await history();
    const [epic] = (await store.snapshot()).tasks;
    for (const tasks of [
      [{ ...epic, status: "done" }],
      [{ ...epic, createdAt: "yesterday" }],
      [{ ...epic, id: "" }],
      [{ ...epic, extra: true }],
    ]) {
      expect(
        taskSnapshotSchema.safeParse({ dependencies: [], tasks }).success
      ).toBe(false);
    }
    expect(
      taskDependencySchema.safeParse({ dependsOnId: "tk-1", taskId: "" })
        .success
    ).toBe(false);
    expect(taskStoreWriteSchema.safeParse({ putEdges: [] }).success).toBe(
      false
    );
  });
});
