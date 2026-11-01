import { describe, expect, test } from "vitest";
import { TaskError } from "../errors";
import type { TaskOperation, TaskToken } from "../operations";
import { MemoryTaskStore } from "../store";
import { Tasks } from "../tasks";

/** A fixed clock; `Tasks` keeps instants strictly increasing on its own. */
const clock = () => new Date("2026-10-29T00:00:00.000Z");

async function failure(work: Promise<unknown>): Promise<TaskError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TaskError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a TaskError");
}

describe("Tasks", () => {
  test("one batch creates a tree, links it, and reports every record", async () => {
    const tasks = new Tasks({ clock });
    const result = await tasks.change({
      operations: [
        { input: { title: "Ship tasks" }, key: "epic", kind: "task.create" },
        {
          input: { title: " Design " },
          key: "design",
          kind: "task.create",
          parent: { key: "epic" },
        },
        {
          input: { metadata: { size: "m" }, title: "Build" },
          key: "build",
          kind: "task.create",
          parent: { key: "epic" },
        },
        {
          dependsOn: { key: "design" },
          kind: "dependency.add",
          task: { key: "build" },
        },
      ],
    });

    expect(result.changed.map((item) => item.key)).toEqual([
      "epic",
      "design",
      "build",
    ]);
    const [epic, design, build] = result.tasks;
    expect(design?.title).toBe("Design");
    expect(design?.parentId).toBe(epic?.id);
    expect(build?.metadata).toEqual({ size: "m" });
    expect(build?.status).toBe("open");
    expect(build?.settledAt).toBeNull();
    expect((await tasks.children(epic?.id ?? "")).map((t) => t.id)).toEqual([
      design?.id,
      build?.id,
    ]);
    expect(
      (await tasks.dependencies(build?.id ?? "")).dependsOn.map((t) => t.id)
    ).toEqual([design?.id]);
    expect(
      (await tasks.dependencies(design?.id ?? "")).dependents.map((t) => t.id)
    ).toEqual([build?.id]);
  });

  test("ready offers open unblocked work oldest first and tracks settlement", async () => {
    const tasks = new Tasks({ clock });
    const first = await tasks.create({ title: "first" });
    const second = await tasks.create(
      { title: "second" },
      { dependsOn: [{ id: first.id }] }
    );
    const third = await tasks.create({ title: "third" });

    expect((await tasks.ready()).items.map((t) => t.id)).toEqual([
      first.id,
      third.id,
    ]);
    expect(await tasks.availability(second.id)).toEqual({
      blockedBy: [first.id],
      kind: "blocked",
      waitingOn: [],
    });

    await tasks.start(first.id);
    expect(await tasks.availability(first.id)).toEqual({ kind: "active" });
    expect((await tasks.ready()).items.map((t) => t.id)).toEqual([third.id]);

    const done = await tasks.complete(first.id);
    expect(done.status).toBe("completed");
    expect(done.settledAt).toBe(done.updatedAt);
    expect((await tasks.ready()).items.map((t) => t.id)).toEqual([
      second.id,
      third.id,
    ]);

    await tasks.cancel(third.id);
    expect(await tasks.availability(third.id)).toEqual({
      kind: "settled",
      status: "cancelled",
    });
    expect((await tasks.list({ status: "cancelled" })).items).toHaveLength(1);
  });

  test("status moves are explicit: reopen is allowed, settled to settled is not", async () => {
    const tasks = new Tasks({ clock });
    const task = await tasks.create({ title: "flip" });
    await tasks.complete(task.id);

    const refused = await failure(tasks.cancel(task.id));
    expect(refused.code).toBe("invalid_status");

    const reopened = await tasks.change({
      operations: [
        { kind: "task.set_status", status: "open", task: { id: task.id } },
      ],
    });
    expect(reopened.tasks[0]?.settledAt).toBeNull();
    expect((await tasks.complete(task.id)).status).toBe("completed");
  });

  test("a stale token refuses the write", async () => {
    const tasks = new Tasks({ clock });
    const task = await tasks.create({ title: "token" });
    const fresh = await tasks.update(task.id, { title: "renamed" });

    const stale = await failure(
      tasks.start(task.id, { expectedUpdatedAt: task.updatedAt })
    );
    expect(stale.code).toBe("conflict");
    expect(
      (await tasks.start(task.id, { expectedUpdatedAt: fresh.updatedAt }))
        .status
    ).toBe("active");
  });

  test("a shorthand acts on its own arguments, whatever else the token carries", async () => {
    const tasks = new Tasks({ clock });
    const task = await tasks.create({ title: "named" });
    const other = await tasks.create({ title: "other" });
    const token = {
      expectedUpdatedAt: task.updatedAt,
      kind: "task.set_status",
      status: "cancelled",
      task: { id: other.id },
    } as TaskToken;

    const started = await tasks.start(task.id, token);
    expect(started.id).toBe(task.id);
    expect(started.status).toBe("active");
    expect((await tasks.get(other.id))?.status).toBe("open");

    const renamed = await tasks.update(
      task.id,
      { title: "renamed" },
      { ...token, expectedUpdatedAt: started.updatedAt }
    );
    expect(renamed.title).toBe("renamed");
    expect(renamed.status).toBe("active");
  });

  test("a refused batch leaves the store untouched", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ clock, store });
    const a = await tasks.create({ title: "a" });
    const b = await tasks.create({ title: "b" }, { dependsOn: [{ id: a.id }] });

    const cycle = await failure(
      tasks.change({
        operations: [
          { input: { title: "c" }, key: "c", kind: "task.create" },
          {
            dependsOn: { id: b.id },
            kind: "dependency.add",
            task: { id: a.id },
          },
        ],
      })
    );
    expect(cycle.code).toBe("cycle");

    const snapshot = await store.snapshot();
    expect(snapshot.tasks.map((t) => t.title)).toEqual(["a", "b"]);
    expect(snapshot.dependencies).toEqual([
      { dependsOnId: a.id, taskId: b.id },
    ]);
  });

  test("refusals carry stable codes", async () => {
    const tasks = new Tasks({ clock });
    const parent = await tasks.create({ title: "parent" });
    const child = await tasks.create(
      { title: "child" },
      { parent: { id: parent.id } }
    );

    const cases: readonly [string, Promise<unknown>][] = [
      ["not_found", tasks.start("tk-missing")],
      [
        "invalid_operation",
        tasks.change({
          operations: [
            { kind: "task.update", patch: {}, task: { key: "nope" } },
          ],
        }),
      ],
      ["invalid_operation", tasks.update(child.id, { title: "  " })],
      [
        "invalid_placement",
        tasks.change({
          operations: [
            {
              kind: "task.move",
              parent: { id: child.id },
              task: { id: parent.id },
            },
          ],
        }),
      ],
      [
        "cycle",
        tasks.change({
          operations: [
            {
              dependsOn: { id: child.id },
              kind: "dependency.add",
              task: { id: child.id },
            },
          ],
        }),
      ],
      [
        "conflict",
        tasks.change({
          operations: [
            {
              input: { id: child.id, title: "dup" },
              key: "dup",
              kind: "task.create",
            },
          ],
        }),
      ],
      [
        "not_found",
        tasks.change({
          operations: [
            {
              dependsOn: { id: parent.id },
              kind: "dependency.remove",
              task: { id: child.id },
            },
          ],
        }),
      ],
    ];
    for (const [code, work] of cases) {
      expect((await failure(work)).code).toBe(code);
    }
  });

  test("remove is guarded by children and host references, then drops edges", async () => {
    let held = true;
    const store = new MemoryTaskStore();
    const tasks = new Tasks({
      clock,
      inUse: () => Promise.resolve(held),
      store,
    });
    const parent = await tasks.create({ title: "parent" });
    const child = await tasks.create(
      { title: "child" },
      { parent: { id: parent.id } }
    );
    const other = await tasks.create(
      { title: "other" },
      { dependsOn: [{ id: child.id }] }
    );

    expect((await failure(tasks.remove(parent.id))).code).toBe(
      "invalid_operation"
    );
    expect((await failure(tasks.remove(child.id))).code).toBe("task_in_use");

    held = false;
    await tasks.remove(child.id);
    expect(await tasks.get(child.id)).toBeNull();
    expect((await store.snapshot()).dependencies).toEqual([]);
    expect(await tasks.availability(other.id)).toEqual({ kind: "ready" });
    await tasks.remove(parent.id);
    expect((await tasks.list()).total).toBe(1);
  });

  test("list filters by parent and pages by offset", async () => {
    const tasks = new Tasks({ clock });
    const root = await tasks.create({ title: "root" });
    for (const title of ["a", "b", "c"]) {
      await tasks.create({ title }, { parent: { id: root.id } });
    }

    expect(
      (await tasks.list({ parentId: null })).items.map((t) => t.title)
    ).toEqual(["root"]);
    const page = await tasks.list({ limit: 2, parentId: root.id });
    expect(page.items.map((t) => t.title)).toEqual(["a", "b"]);
    expect(page.total).toBe(3);
    const rest = await tasks.list({
      cursor: page.nextCursor,
      limit: 2,
      parentId: root.id,
    });
    expect(rest.items.map((t) => t.title)).toEqual(["c"]);
    expect(rest.nextCursor).toBeUndefined();
  });

  test("the parent gate holds children until the parent is started", async () => {
    const tasks = new Tasks({ clock, parentGate: true });
    const parent = await tasks.create({ title: "parent" });
    const child = await tasks.create(
      { title: "child" },
      { parent: { id: parent.id } }
    );

    expect(await tasks.availability(child.id)).toEqual({
      blockedBy: [],
      kind: "blocked",
      waitingOn: [parent.id],
    });
    await tasks.start(parent.id);
    expect(await tasks.availability(child.id)).toEqual({ kind: "ready" });
  });

  test("requireReady starts a task only if it is ready when the batch commits", async () => {
    const tasks = new Tasks({ clock, parentGate: true });
    const blocker = await tasks.create({ title: "blocker" });
    const work = await tasks.create({ title: "work" });
    const startWhenReady = (id: string, before: TaskOperation[] = []) =>
      tasks.change({
        operations: [
          ...before,
          {
            kind: "task.set_status",
            requireReady: true,
            status: "active",
            task: { id },
          },
        ],
      });

    // A dependency added after the caller last read the task leaves its
    // token unchanged, so only the commit-time check refuses the start.
    await tasks.change({
      operations: [
        {
          dependsOn: { id: blocker.id },
          kind: "dependency.add",
          task: { id: work.id },
        },
      ],
    });
    const refused = await failure(startWhenReady(work.id));
    expect(refused.code).toBe("not_ready");
    expect(refused.message).toContain(`depends on open ${blocker.id}`);
    expect((await tasks.get(work.id))?.status).toBe("open");

    // Earlier operations in the same batch count, in order.
    const fresh = await tasks.create({ title: "fresh" });
    expect(
      (
        await failure(
          startWhenReady(fresh.id, [
            {
              dependsOn: { id: blocker.id },
              kind: "dependency.add",
              task: { id: fresh.id },
            },
          ])
        )
      ).code
    ).toBe("not_ready");
    expect(await tasks.dependencies(fresh.id)).toEqual({
      dependents: [],
      dependsOn: [],
    });

    // The parent gate is the instance's own.
    const child = await tasks.create(
      { title: "child" },
      { parent: { id: fresh.id } }
    );
    expect((await failure(startWhenReady(child.id))).message).toContain(
      `waits on open parent ${fresh.id}`
    );

    await tasks.complete(blocker.id);
    const started = await startWhenReady(work.id);
    expect(started.tasks[0]?.status).toBe("active");
    // Already active is not ready either: a second runner cannot take it.
    expect((await failure(startWhenReady(work.id))).code).toBe("not_ready");
    // Without the flag, start is unguarded, as before.
    expect((await tasks.start(child.id)).status).toBe("active");
  });

  test("concurrent mutations serialize and keep ids and instants unique", async () => {
    const tasks = new Tasks({ clock });
    const count = 20;
    const created = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        tasks.create({ title: `t${index}` })
      )
    );
    expect(new Set(created.map((t) => t.id)).size).toBe(count);
    expect(new Set(created.map((t) => t.updatedAt)).size).toBe(count);
    expect((await tasks.list()).items.map((t) => t.title)).toEqual(
      created.map((t) => t.title)
    );
  });

  test("the memory store hands out detached records", async () => {
    const store = new MemoryTaskStore();
    const tasks = new Tasks({ clock, store });
    const task = await tasks.create({ metadata: { tags: ["a"] }, title: "x" });
    const read = await store.get(task.id);
    const tags = read?.metadata.tags;
    if (Array.isArray(tags)) {
      (tags as string[]).push("b");
    }
    expect((await tasks.get(task.id))?.metadata).toEqual({ tags: ["a"] });
  });
  test("batches return every record they name, targets after their own task", async () => {
    const tasks = new Tasks({ clock });
    const a = await tasks.create({ title: "a" });
    const b = await tasks.create({ title: "b" });

    const linked = await tasks.change({
      operations: [
        { dependsOn: { id: a.id }, kind: "dependency.add", task: { id: b.id } },
      ],
    });
    expect(linked.changed).toEqual([{ id: b.id }, { id: a.id }]);
    expect(linked.tasks).toEqual([b, a]);

    const nested = await tasks.change({
      operations: [
        {
          input: { title: "c" },
          key: "c",
          kind: "task.create",
          parent: { id: a.id },
        },
      ],
    });
    expect(nested.changed.map((item) => item.id)).toEqual([
      nested.tasks[0]?.id,
      a.id,
    ]);
    expect(nested.tasks[1]).toEqual(a);

    const same = await tasks.change({
      operations: [
        { kind: "task.set_status", status: "open", task: { id: a.id } },
        { kind: "task.move", parent: null, task: { id: a.id } },
      ],
    });
    expect(same.tasks).toEqual([a]);
    expect((await tasks.start(a.id)).status).toBe("active");
  });

  test("tokens stay unique across instances over one store with a fixed clock", async () => {
    const store = new MemoryTaskStore();
    const task = await new Tasks({ clock, store }).create({ title: "shared" });

    const later = new Tasks({ clock, store });
    const renamed = await later.update(task.id, { title: "renamed" });
    expect(renamed.updatedAt).not.toBe(task.updatedAt);

    const stale = await failure(
      later.start(task.id, { expectedUpdatedAt: task.updatedAt })
    );
    expect(stale.code).toBe("conflict");
  });

  test("ids may contain any character without edges colliding", async () => {
    const tasks = new Tasks({ clock });
    for (const id of ["x", "y\u0000z", "x\u0000y", "z"]) {
      await tasks.create({ id, title: id });
    }
    await tasks.change({
      operations: [
        {
          dependsOn: { id: "y\u0000z" },
          kind: "dependency.add",
          task: { id: "x" },
        },
        {
          dependsOn: { id: "z" },
          kind: "dependency.add",
          task: { id: "x\u0000y" },
        },
      ],
    });
    expect((await tasks.dependencies("x")).dependsOn.map((t) => t.id)).toEqual([
      "y\u0000z",
    ]);
    expect(
      (await tasks.dependencies("x\u0000y")).dependsOn.map((t) => t.id)
    ).toEqual(["z"]);
  });

  test("depth expands subtasks on get, list, and children", async () => {
    const tasks = new Tasks({ clock });
    const root = await tasks.create({ title: "root" });
    const mid = await tasks.create(
      { title: "mid" },
      { parent: { id: root.id } }
    );
    const leaf = await tasks.create(
      { title: "leaf" },
      { parent: { id: mid.id } }
    );
    await tasks.create({ title: "solo" });

    expect(await tasks.get(root.id)).toEqual(root);
    expect(await tasks.get(root.id, { depth: 1 })).toEqual({
      ...root,
      subtasks: [mid],
    });
    expect(await tasks.get(root.id, { depth: 2 })).toEqual({
      ...root,
      subtasks: [{ ...mid, subtasks: [leaf] }],
    });
    expect(await tasks.get(leaf.id, { depth: 3 })).toEqual({
      ...leaf,
      subtasks: [],
    });

    const roots = await tasks.list({ depth: 2, parentId: null });
    expect(roots.items.map((t) => t.subtasks?.length)).toEqual([1, 0]);
    expect(roots.items[0]?.subtasks?.[0]?.subtasks).toEqual([leaf]);
    expect((await tasks.list()).items[0]).not.toHaveProperty("subtasks");

    expect(await tasks.children(root.id, { depth: 1 })).toEqual([
      { ...mid, subtasks: [leaf] },
    ]);
    await expect(tasks.get(root.id, { depth: -1 })).rejects.toThrow(RangeError);
  });
});
