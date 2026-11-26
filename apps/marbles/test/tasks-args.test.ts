import { expect, it } from "vitest";
import { UsageError } from "~/cli/errors";
import { parseArgs } from "~/cli/index";

function task(argv: readonly string[]) {
  const args = parseArgs(["tasks", ...argv]);
  if (args.command !== "tasks") {
    throw new Error(`parsed ${args.command}`);
  }
  return args;
}

it("defaults to list and reads list, --ready, and get queries with optional --workspace", () => {
  expect(task([])).toMatchObject({
    json: false,
    task: { kind: "list", query: {} },
  });
  expect(
    task(["--ready", "--limit", "3", "--workspace", "ws-1"])
  ).toMatchObject({
    json: false,
    task: { kind: "ready", query: { limit: 3 } },
    workspace: "ws-1",
  });
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
      "--json",
    ])
  ).toMatchObject({
    json: true,
    task: {
      kind: "list",
      query: {
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
  expect(task(["list", "--ready", "--limit", "3"])).toMatchObject({
    json: false,
    task: { kind: "ready", query: { limit: 3 } },
  });
  expect(
    task(["get", "tk-1", "--depth", "1", "--workspace", "ws-1"])
  ).toMatchObject({
    task: {
      depth: 1,
      id: "tk-1",
      kind: "inspect",
    },
    workspace: "ws-1",
  });
});

it("compiles create and update (including status and parent moves) into atomic batches", () => {
  expect(
    task([
      "create",
      "Write docs",
      "--description",
      "the guide",
      "--parent",
      "tk-epic",
      "--workspace",
      "ws-1",
    ])
  ).toMatchObject({
    task: {
      change: {
        operations: [
          {
            input: { description: "the guide", title: "Write docs" },
            key: "task",
            kind: "task.create",
            parent: { id: "tk-epic" },
          },
        ],
      },
      kind: "change",
    },
    workspace: "ws-1",
  });
  expect(
    task([
      "update",
      "tk-1",
      "--title",
      "New",
      "--status",
      "completed",
      "--parent",
      "tk-2",
    ]).task
  ).toEqual({
    change: {
      operations: [
        {
          kind: "task.update",
          patch: { title: "New" },
          task: { id: "tk-1" },
        },
        {
          kind: "task.set_status",
          status: "completed",
          task: { id: "tk-1" },
        },
        {
          kind: "task.move",
          parent: { id: "tk-2" },
          task: { id: "tk-1" },
        },
      ],
    },
    kind: "change",
  });
  for (const status of ["open", "active", "completed", "cancelled"] as const) {
    expect(task(["update", "tk-1", "--status", status]).task).toEqual({
      change: {
        operations: [{ kind: "task.set_status", status, task: { id: "tk-1" } }],
      },
      kind: "change",
    });
  }
  expect(task(["update", "tk-1", "--root"]).task).toMatchObject({
    change: { operations: [{ kind: "task.move", parent: null }] },
  });
});

it("reads tags as filters, on create, and as a replacement on update", () => {
  expect(task(["list", "--tag", "a", "--tag", "b"]).task).toMatchObject({
    query: { tags: { all: ["a", "b"] } },
  });
  expect(task(["list", "--ready", "--tag", "c"]).task).toMatchObject({
    query: { tags: { all: ["c"] } },
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

it("refuses unknown actions, removed actions, and removed flags", () => {
  const refusals: [readonly string[], string | RegExp][] = [
    [
      ["remove", "tk-1"],
      'tasks takes list, get, create, or update (got "remove")',
    ],
    [["ready"], 'tasks takes list, get, create, or update (got "ready")'],
    [["deps", "tk-1"], 'tasks takes list, get, create, or update (got "deps")'],
    [
      ["start", "tk-1"],
      'tasks takes list, get, create, or update (got "start")',
    ],
    [
      ["complete", "tk-1"],
      'tasks takes list, get, create, or update (got "complete")',
    ],
    [
      ["move", "tk-1", "--root"],
      'tasks takes list, get, create, or update (got "move")',
    ],
    [["change"], 'tasks takes list, get, create, or update (got "change")'],
    [["list", "--tags", "x"], "tasks list: unknown option --tags"],
    [["list", "--any-tag", "x"], "tasks list: unknown option --any-tag"],
    [["list", "--cursor", "1"], "tasks list: unknown option --cursor"],
    [
      ["update", "tk-1", "--expect", "x"],
      "tasks update: unknown option --expect",
    ],
    [
      ["update", "tk-1", "--metadata", "{}"],
      "tasks update: unknown option --metadata",
    ],
    [["list", "--status", "done"], "tasks list:"],
    [["list", "--limit", "0"], "tasks list:"],
    [["list", "--limit", "many"], "--limit takes an integer"],
    [["list", "--root", "--parent", "tk-1"], "--root or --parent, not both"],
    [["list", "extra"], 'tasks list: unexpected "extra"'],
    [
      ["list", "--ready", "--status", "open"],
      "tasks list does not take --status",
    ],
    [["get"], "tasks get takes a task id"],
    [["get", "tk-1", "--depth"], "--depth takes a value"],
    [["create"], "tasks create takes a title"],
    [["create", "A", "B"], 'unexpected "B"'],
    [["create", ""], "tasks create:"],
    [
      ["update", "tk-1"],
      "tasks update takes --status, --title, --description, --parent, --root, --tag, or --clear-tags",
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
    [["update", "tk-1", "--status", "done"], "tasks update:"],
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

it("takes an option's value literally, even when it spells a global flag", () => {
  for (const value of ["--help", "-h", "--json"]) {
    const args = task(["create", "Fix", "--description", value]);
    expect(args).toMatchObject({ command: "tasks", json: false });
    expect(args.task).toMatchObject({
      change: {
        operations: [
          { input: { description: value, title: "Fix" }, kind: "task.create" },
        ],
      },
    });
  }
  expect(task(["update", "tk-1", "--title", "--json", "--json"])).toMatchObject(
    {
      json: true,
      task: { change: { operations: [{ patch: { title: "--json" } }] } },
    }
  );
});

it("refuses a task option with no value, or a flag it does not know, even beside --help", () => {
  expect(() => parseArgs(["tasks", "create", "Fix", "--description"])).toThrow(
    "tasks create: --description takes a value"
  );
  expect(() => parseArgs(["tasks", "list", "--tags", "--help"])).toThrow(
    "tasks list: unknown option --tags"
  );
  expect(parseArgs(["tasks", "create", "--help"]).command).toBe("help");
});
