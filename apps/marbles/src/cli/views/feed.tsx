import { FeedList } from "~/components/blocks/feed-list";
import { FeedReader } from "~/components/blocks/feed-reader";
import {
  ALL_WORKSPACES,
  feedItem,
  feedKey,
  feedRows,
} from "../state/feed-model";
import type { FeedState } from "../state/use-feed";

const LIST_SHARE = 0.38;
const MIN_LIST_WIDTH = 30;
const MAX_LIST_WIDTH = 52;
const STACK_BELOW = 90;

export function FeedView({
  feed,
  inputActive,
  width,
}: {
  readonly feed: FeedState;
  readonly inputActive: boolean;
  readonly width: number;
}) {
  const stacked = width < STACK_BELOW;
  const listWidth = Math.max(
    MIN_LIST_WIDTH,
    Math.min(MAX_LIST_WIDTH, Math.floor(width * LIST_SHARE))
  );
  const list = (
    <FeedList
      active={!inputActive && feed.focus === "list"}
      filtered={feed.scope.id !== ALL_WORKSPACES}
      onReset={feed.resetScope}
      onSelect={feed.select}
      rows={feedRows(feed.visible, feed.selected)}
      scopeLabel={feed.scope.label}
      selectedKey={feed.selected && feedKey(feed.selected)}
    />
  );
  const reader = (
    <FeedReader
      active={!inputActive && feed.focus === "reader"}
      answer={feed.answer}
      selected={feed.selected && feedItem(feed.selected)}
    />
  );
  return (
    <box
      flexDirection={stacked ? "column" : "row"}
      flexGrow={1}
      gap={stacked ? 0 : 1}
      minHeight={0}
    >
      <box
        flexDirection="column"
        flexShrink={0}
        height={stacked ? "40%" : undefined}
        width={stacked ? "100%" : listWidth}
      >
        {list}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        {reader}
      </box>
    </box>
  );
}
