import type { RunRecord } from "@foundry/workflows/store";
import { expect, it } from "vitest";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { runRows } from "~/views/dashboard-tree";

const record: RunRecord = {
  error: null,
  extensions: {},
  id: "run-live",
  input: null,
  metadata: {
    workflow: {
      steps: {
        review: {
          attempt: 1,
          name: "Review",
          namespace: "",
          status: "running",
        },
        "review.other": {
          attempt: 1,
          name: "Other",
          namespace: "review",
          status: "running",
        },
        "review.write": {
          attempt: 1,
          name: "Write",
          namespace: "review",
          status: "running",
        },
      },
    },
  },
  output: null,
  queueId: "queue",
  snapshot: {
    cursor: null,
    input: null,
    name: "Review",
    steps: [
      {
        children: [
          { index: 0, key: "review.write", name: "Write" },
          { index: 1, key: "review.other", name: "Other" },
        ],
        index: 0,
        key: "review",
        name: "Review",
      },
    ],
  },
  status: "running",
  step: "review",
  tags: {},
  timestamps: {
    completedAt: null,
    createdAt: 100,
    failedAt: null,
    startedAt: 100,
  },
};

const entry: FeedEntrySnapshot = {
  body: "Approve this action?",
  definition: "review",
  id: "input-1",
  input: {
    choices: ["Approve once", "Allow for this session", "Deny"],
    delivery: "live",
    mode: "approval",
    status: "open",
  },
  kind: "input",
  media: [],
  posted: "now",
  postedAt: new Date(100).toISOString(),
  run: record.id,
  step: "review.write",
  title: "Allow writing?",
  workspace: { id: "workspace", name: "workspace" },
};

function snapshot(feed: readonly FeedEntrySnapshot[], run = record) {
  return dashboardSnapshot([run], {
    definitions: [],
    feed,
    lastFinish: new Map(),
    monitors: new Map(),
    now: 200,
    root: "/workspace",
    schedules: [],
    startedAt: 100,
    status: "Ready",
    workspaceId: "workspace",
  });
}

it("derives live approval attention in the run, target step and its running ancestors", () => {
  const projected = snapshot([entry]);
  const [run] = projected.runs;
  expect(run).toMatchObject({ attention: "approval", status: "running" });
  expect(run?.steps[0]).toMatchObject({
    attention: "approval",
    status: "running",
  });
  expect(run?.steps[0]?.children[0]).toMatchObject({
    attention: "approval",
    status: "running",
  });
  expect(run?.steps[0]?.children[1]?.attention).toBeUndefined();
  const rows = runRows(projected.runs, new Set(), true);
  expect(rows.filter((row) => row.attention === "approval")).toHaveLength(3);
  expect(rows.every((row) => row.status === "running")).toBe(true);
  expect(record.status).toBe("running");
});

it("distinguishes questions and gives outstanding approvals priority for the run", () => {
  const question: FeedEntrySnapshot = {
    ...entry,
    id: "question",
    input: { choices: [], delivery: "live", mode: "question", status: "open" },
    step: "review.other",
  };
  expect(snapshot([question]).runs[0]?.attention).toBe("question");
  const [run] = snapshot([question, entry]).runs;
  expect(run?.attention).toBe("approval");
  expect(run?.steps[0]?.children[1]?.attention).toBe("question");
});

it.each(["answered", "cancelled"] as const)(
  "clears attention when the live input is %s",
  (status) => {
    const [run] = snapshot([
      { ...entry, input: { ...entry.input, choices: [], status } },
    ]).runs;
    expect(run?.status).toBe("running");
    expect(run?.attention).toBeUndefined();
    expect(run?.steps[0]?.children[0]?.attention).toBeUndefined();
  }
);

it.each(["deferred", undefined] as const)(
  "does not present %s input as a live wait",
  (delivery) => {
    const [run] = snapshot([
      {
        ...entry,
        input: {
          choices: [],
          mode: "approval",
          status: "open",
          ...(delivery ? { delivery } : {}),
        },
      },
    ]).runs;
    expect(run?.attention).toBeUndefined();
    expect(run?.steps[0]?.attention).toBeUndefined();
  }
);

it("ignores questions belonging to another run or workspace", () => {
  const [run] = snapshot([
    { ...entry, run: "other-run" },
    { ...entry, workspace: { id: "other-workspace", name: "other" } },
  ]).runs;
  expect(run?.attention).toBeUndefined();
});

it.each(["complete", "cancelled", "failed", "suspended", "queued"] as const)(
  "preserves %s run presentation even if a stale live entry is open",
  (status) => {
    const [run] = snapshot([entry], { ...record, status }).runs;
    expect(run?.status).toBe(status);
    expect(run?.attention).toBeUndefined();
    expect(run?.steps[0]?.attention).toBeUndefined();
  }
);

it("preserves operator-paused step presentation during an open live input", () => {
  const paused = {
    ...record,
    metadata: {
      workflow: {
        steps: {
          review: {
            attempt: 1,
            name: "Review",
            namespace: "",
            status: "running",
          },
          "review.write": {
            attempt: 1,
            name: "Write",
            namespace: "review",
            status: "paused",
          },
        },
      },
    },
  };
  const [run] = snapshot([entry], paused).runs;
  expect(run?.status).toBe("running");
  expect(run?.steps[0]?.children[0]?.status).toBe("paused");
  expect(run?.steps[0]?.children[0]?.attention).toBeUndefined();
});
