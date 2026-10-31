import { expect, it } from "vitest";
import { parseArgs, UsageError } from "~/args";

function task(argv: readonly string[]) {
  const args = parseArgs(["tasks", ...argv]);
  if (args.command !== "tasks") {
    throw new Error(`parsed ${args.command}`);
  }
  return args;
}

it("reads queries, checked by the Tasks package's schemas", () => {
  expect(
    task([
      "list",
      "--status",
      "open",
      "--parent",
      "tk-1",
      "--depth",
      "2",
      "--limit",
      "5",
      "--cursor",
      "10",
      "--json",
    ])
  ).toMatchObject({
    json: true,
    task: {
      kind: "list",
      query: {
        cursor: 10,
        depth: 2,
        limit: 5,
        parentId: "tk-1",
        status: "open",
      },
    },
  });
  expect(task(["list", "--root"]).task).toMatchObject({
    query: { parentId: null },
  });
  expect(task(["ready", "--limit", "3"])).toMatchObject({
    json: false,
    task: { kind: "ready", query: { limit: 3 } },
  });
  expect(task(["get", "tk-1", "--depth", "1"]).task).toEqual({
    depth: 1,
    id: "tk-1",
    kind: "get",
  });
  expect(task(["deps", "tk-1"]).task).toEqual({
    id: "tk-1",
    kind: "dependencies",
  });
});

it("compiles every write to one batch in the task command language", () => {
  expect(
    task([
      "create",
      "Write docs",
      "--description",
      "the guide",
      "--parent",
      "tk-epic",
      "--depends-on",
      "tk-a",
      "--depends-on",
      "tk-b",
    ]).task
  ).toEqual({
    change: {
      operations: [
        {
          input: { description: "the guide", title: "Write docs" },
          key: "task",
          kind: "task.create",
          parent: { id: "tk-epic" },
        },
        {
          dependsOn: { id: "tk-a" },
          kind: "dependency.add",
          task: { key: "task" },
        },
        {
          dependsOn: { id: "tk-b" },
          kind: "dependency.add",
          task: { key: "task" },
        },
      ],
    },
    kind: "change",
  });
  const expect_ = "2026-10-29T00:00:00.000Z";
  expect(
    task(["update", "tk-1", "--title", "New", "--expect", expect_]).task
  ).toEqual({
    change: {
      operations: [
        {
          expectedUpdatedAt: expect_,
          kind: "task.update",
          patch: { title: "New" },
          task: { id: "tk-1" },
        },
      ],
    },
    kind: "change",
  });
  const statuses = {
    cancel: "cancelled",
    complete: "completed",
    reopen: "open",
    start: "active",
  } as const;
  for (const [action, status] of Object.entries(statuses)) {
    expect(task([action, "tk-1"]).task).toEqual({
      change: {
        operations: [{ kind: "task.set_status", status, task: { id: "tk-1" } }],
      },
      kind: "change",
    });
  }
  expect(task(["move", "tk-1", "--root"]).task).toMatchObject({
    change: { operations: [{ kind: "task.move", parent: null }] },
  });
  expect(task(["move", "tk-1", "--parent", "tk-2"]).task).toMatchObject({
    change: { operations: [{ kind: "task.move", parent: { id: "tk-2" } }] },
  });
  expect(task(["depend", "tk-1", "tk-2"]).task).toMatchObject({
    change: {
      operations: [
        {
          dependsOn: { id: "tk-2" },
          kind: "dependency.add",
          task: { id: "tk-1" },
        },
      ],
    },
  });
  expect(task(["undepend", "tk-1", "tk-2"]).task).toMatchObject({
    change: { operations: [{ kind: "dependency.remove" }] },
  });
  const batch = {
    operations: [{ input: { title: "A" }, key: "a", kind: "task.create" }],
  };
  expect(
    task(["change", "--input", JSON.stringify(batch), "--json"])
  ).toMatchObject({ json: true, task: { change: batch, kind: "change" } });
});

it("reads tags as filters, on create, and as a replacement on update", () => {
  expect(
    task(["list", "--tag", "a", "--tag", "b", "--any-tag", "c"]).task
  ).toMatchObject({
    query: { tags: { all: ["a", "b"], any: ["c"] } },
  });
  expect(task(["ready", "--any-tag", "c"]).task).toMatchObject({
    query: { tags: { any: ["c"] } },
  });
  expect(task(["list"]).task).toMatchObject({ query: { tags: undefined } });
  expect(task(["create", "T", "--tag", "a", "--tag", ""]).task).toMatchObject({
    change: { operations: [{ input: { tags: ["a", ""], title: "T" } }] },
  });
  expect(task(["update", "tk-1", "--tag", "x"]).task).toMatchObject({
    change: { operations: [{ patch: { tags: ["x"] } }] },
  });
  expect(task(["update", "tk-1", "--clear-tags"]).task).toMatchObject({
    change: { operations: [{ patch: { tags: [] } }] },
  });
});

it("refuses a tasks line that cannot run, before anything loads", () => {
  const refusals: [readonly string[], string | RegExp][] = [
    [[], "tasks takes an action: cancel, change"],
    [["remove", "tk-1"], "tasks takes an action"],
    [["list", "--tags", "x"], "tasks list: unknown option --tags"],
    [["list", "--status", "done"], "tasks list:"],
    [["list", "--limit", "0"], "tasks list:"],
    [["list", "--limit", "many"], "--limit takes an integer"],
    [["list", "--cursor", "-1"], "tasks list:"],
    [["list", "--root", "--parent", "tk-1"], "--root or --parent, not both"],
    [["list", "extra"], 'tasks list: unexpected "extra"'],
    [["ready", "--status", "open"], "tasks ready does not take --status"],
    [["get"], "tasks get takes a task id"],
    [["get", "tk-1", "--depth"], "--depth takes a value"],
    [["create"], "tasks create takes a title"],
    [["create", "A", "B"], 'unexpected "B"'],
    [["create", ""], "tasks create:"],
    [
      ["update", "tk-1"],
      "tasks update takes --title, --description, --tag, or --clear-tags",
    ],
    [
      ["update", "tk-1", "--tag", "a", "--clear-tags"],
      "--tag or --clear-tags, not both",
    ],
    [
      ["create", "A", "--clear-tags"],
      "tasks create does not take --clear-tags",
    ],
    [["get", "tk-1", "--tag", "a"], "tasks get does not take --tag"],
    [["update", "tk-1", "--title", ""], "tasks update:"],
    [["start", "tk-1", "--expect", "yesterday"], "tasks start:"],
    [["move", "tk-1"], "tasks move takes --parent <id> or --root"],
    [["depend", "tk-1"], "tasks depend takes a task id and the id"],
    [["list", "--input", "{}"], "--input is for tasks change"],
    [["change"], "tasks change takes --input"],
    [["change", "--input", "{"], "--input is not JSON"],
    [["change", "--input", '{"operations":[]}'], "tasks change:"],
    [
      [
        "change",
        "--input",
        '{"operations":[{"kind":"task.delete","task":{"id":"x"}}]}',
      ],
      "tasks change:",
    ],
  ];
  for (const [argv, message] of refusals) {
    expect(() => parseArgs(["tasks", ...argv]), argv.join(" ")).toThrow(
      UsageError
    );
    expect(() => parseArgs(["tasks", ...argv]), argv.join(" ")).toThrow(
      message
    );
  }
  expect(parseArgs(["tasks", "list", "--help"]).command).toBe("help");
});
