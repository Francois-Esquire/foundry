import { expect, it } from "vitest";
import { feedItem, feedKey, feedRows } from "~/cli/state/feed-model";
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
  expect(feedItem(entry)).toEqual({ entry, key: feedKey(entry) });
});
