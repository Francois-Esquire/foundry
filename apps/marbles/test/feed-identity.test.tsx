import { act, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { dashboardSnapshot } from "../preview/snapshot";
import { feedKey } from "../src/cli/state/feed-model";
import { useFeed } from "../src/cli/state/use-feed";
import type { FeedEntrySnapshot } from "../src/lib/feed/read";
import { mount, unmount } from "./helpers/render";

afterEach(unmount);

const template: FeedEntrySnapshot = (() => {
  const [first] = dashboardSnapshot.feed;
  if (first === undefined) {
    throw new Error("the preview snapshot has a feed entry");
  }
  return first;
})();

function entriesFrom(...workspaces: string[]): FeedEntrySnapshot[] {
  return workspaces.map((id) => ({
    ...template,
    id: "same",
    workspace: { id, name: id },
  }));
}

let state: ReturnType<typeof useFeed> | undefined;
let reorder: ((next: FeedEntrySnapshot[]) => void) | undefined;

function Probe() {
  const [entries, setEntries] = useState(() => entriesFrom("one", "two"));
  reorder = setEntries;
  state = useFeed(entries, "one", () => Promise.resolve());
  return <text>{state.selected?.workspace.id}</text>;
}

test("moves between two workspaces' entries of one id, and keeps the one chosen when they reorder", async () => {
  await mount(<Probe />);
  expect(state?.selected?.workspace.id).toBe("one");
  await act(async () => state?.move(1));
  expect(state?.selected?.workspace.id).toBe("two");
  await act(async () => reorder?.(entriesFrom("two", "one")));
  expect(state?.selected?.workspace.id).toBe("two");
  await act(async () => state?.move(1));
  expect(state?.selected?.workspace.id).toBe("one");
});

test("keys two workspaces' entries of one id apart, whatever the id holds", () => {
  const [one, two] = entriesFrom("one", "two");
  if (one === undefined || two === undefined) {
    throw new Error("two entries");
  }
  expect(feedKey(one)).not.toBe(feedKey(two));
  expect(feedKey({ ...one, id: 'a","b' })).not.toBe(
    feedKey({ ...one, id: "a", workspace: { id: 'one","a', name: "" } })
  );
});
