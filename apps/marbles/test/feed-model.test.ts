import { expect, it } from "vitest";
import {
  ALL_WORKSPACES,
  feedItem,
  feedKey,
  feedMeta,
  feedModel,
  feedRows,
} from "~/cli/state/feed-model";
import type { FeedState } from "~/cli/state/use-feed";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

it("keys feed rows by workspace and id and marks the selected one", () => {
  const { feed } = dashboardSnapshot;
  const rows = feedRows(feed, feed[1]);
  expect(rows.map(({ key, selected }) => [key, selected])).toEqual(
    feed.map((entry, index) => [feedKey(entry), index === 1])
  );
  expect(rows[0]?.entry).toBe(feed[0]);
  expect(feedRows(feed).some((row) => row.selected)).toBe(false);
});

it("pairs an entry with its key", () => {
  const [entry] = dashboardSnapshot.feed;
  if (!entry) {
    throw new Error("fixture has no feed entries");
  }
  expect(feedItem(entry)).toEqual({
    entry,
    key: feedKey(entry),
    meta: feedMeta(entry),
  });
});

const [question] = dashboardSnapshot.feed;

function asked(
  input: FeedEntrySnapshot["input"],
  kind: FeedEntrySnapshot["kind"] = "input"
): FeedEntrySnapshot {
  if (!question) {
    throw new Error("fixture has no feed entries");
  }
  const { input: _input, ...rest } = question;
  return { ...rest, kind, ...(input ? { input } : {}) };
}

it("labels an entry by kind and gives an open question the attention tone", () => {
  const open = { choices: ["merge"], status: "open" } as const;
  expect(
    [
      asked(undefined, "result"),
      asked(undefined, "milestone"),
      asked(open),
      asked({ answer: "merge", choices: [], status: "answered" }),
      asked({ choices: [], status: "cancelled" }),
      asked(undefined),
      asked(open, "result"),
    ].map(feedMeta)
  ).toEqual([
    { label: "result", tone: "success" },
    { label: "milestone", tone: "info" },
    { label: "needs input", tone: "attention" },
    { label: "answered", tone: "settled" },
    { label: "cancelled", tone: "settled" },
    { label: "answered", tone: "settled" },
    { label: "result", tone: "attention" },
  ]);
});

it("marks only rows whose question is still open as pending", () => {
  const entries = [
    asked({ choices: [], status: "open" }),
    asked({ choices: [], status: "answered" }),
    asked({ choices: [], status: "cancelled" }),
    asked(undefined, "result"),
  ].map((entry, index) => ({ ...entry, id: `entry-${index}` }));
  expect(feedRows(entries).map((row) => row.pending)).toEqual([
    true,
    false,
    false,
    false,
  ]);
});

function feedState(overrides: Partial<FeedState> = {}): FeedState {
  const { feed } = dashboardSnapshot;
  return {
    answer: {
      cancel: () => undefined,
      choices: [],
      choose: () => undefined,
      choosing: undefined,
      draft: "",
      error: undefined,
      question: undefined,
      sending: false,
      setDraft: () => undefined,
      start: () => undefined,
      submitDraft: () => undefined,
      typing: false,
    },
    browse: () => undefined,
    cycleScope: () => undefined,
    focus: "list",
    move: () => undefined,
    read: () => undefined,
    resetScope: () => undefined,
    scope: { id: ALL_WORKSPACES, label: "All workspaces" },
    scopeCount: 1,
    select: () => undefined,
    selected: feed[0],
    total: feed.length,
    visible: feed,
    ...overrides,
  };
}

it("lists the feed and reads the selected entry with its answer", () => {
  const state = feedState();
  const [entry] = dashboardSnapshot.feed;
  if (!entry) {
    throw new Error("fixture has no feed entries");
  }
  const model = feedModel(state, false);
  expect(model.list).toMatchObject({
    active: true,
    filtered: false,
    onReset: state.resetScope,
    onSelect: state.select,
    scopeLabel: "All workspaces",
    selectedKey: feedKey(entry),
  });
  expect(model.list.rows).toHaveLength(dashboardSnapshot.feed.length);
  expect(model.reader).toEqual({
    active: false,
    selected: {
      ...feedItem(entry),
      answer: {
        choices: [
          { id: "answer:1", label: "1 merge", value: "merge" },
          { id: "answer:2", label: "2 hold", value: "hold" },
        ],
        kind: "unavailable",
        sending: false,
      },
    },
  });
});

it("focuses neither panel under input and filters by a workspace scope", () => {
  const model = feedModel(
    feedState({
      focus: "reader",
      scope: { id: "ws-foundry", label: "foundry" },
      selected: undefined,
    }),
    true
  );
  expect(model.list).toMatchObject({
    active: false,
    filtered: true,
    selectedKey: undefined,
  });
  expect(model.reader).toEqual({ active: false, selected: undefined });
  expect(feedModel(feedState({ focus: "reader" }), false).reader.active).toBe(
    true
  );
});
