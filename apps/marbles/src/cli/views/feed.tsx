import { FeedList } from "~/components/blocks/feed-list";
import { FeedReader } from "~/components/blocks/feed-reader";
import { FeedLayout } from "~/components/layouts/feed";
import {
  ALL_WORKSPACES,
  feedItem,
  feedKey,
  feedRows,
} from "../state/feed-model";
import type { FeedState } from "../state/use-feed";

export function FeedView({
  feed,
  inputActive,
  width,
}: {
  readonly feed: FeedState;
  readonly inputActive: boolean;
  readonly width: number;
}) {
  return (
    <FeedLayout
      list={
        <FeedList
          active={!inputActive && feed.focus === "list"}
          filtered={feed.scope.id !== ALL_WORKSPACES}
          onReset={feed.resetScope}
          onSelect={feed.select}
          rows={feedRows(feed.visible, feed.selected)}
          scopeLabel={feed.scope.label}
          selectedKey={feed.selected && feedKey(feed.selected)}
        />
      }
      reader={
        <FeedReader
          active={!inputActive && feed.focus === "reader"}
          answer={feed.answer}
          selected={feed.selected && feedItem(feed.selected)}
        />
      }
      width={width}
    />
  );
}
