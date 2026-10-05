import { useTerminalDimensions } from "@opentui/react";
import { FeedList } from "~/components/blocks/feed-list";
import { FeedReader } from "~/components/blocks/feed-reader";
import { ALL_WORKSPACES } from "./feed-model";
import type { FeedState } from "./use-feed";

const LIST_SHARE = 0.38;
const MIN_LIST_WIDTH = 30;
const MAX_LIST_WIDTH = 52;
/** Below this, list and reader stack instead of sitting side by side. */
const STACK_BELOW = 90;

/** Entries on the left, the selected article on the right. */
export function FeedView({
  feed,
  inputActive,
}: {
  readonly feed: FeedState;
  readonly inputActive: boolean;
}) {
  const { width } = useTerminalDimensions();
  const stacked = width < STACK_BELOW;
  const listWidth = Math.max(
    MIN_LIST_WIDTH,
    Math.min(MAX_LIST_WIDTH, Math.floor(width * LIST_SHARE))
  );
  const list = (
    <FeedList
      active={!inputActive && feed.focus === "list"}
      entries={feed.visible}
      filtered={feed.scope.id !== ALL_WORKSPACES}
      onReset={feed.resetScope}
      onSelect={feed.select}
      scopeLabel={feed.scope.label}
      selected={feed.selected}
    />
  );
  const reader = (
    <FeedReader
      active={!inputActive && feed.focus === "reader"}
      answer={feed.answer}
      entry={feed.selected}
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
        {...(stacked ? { height: "40%" } : { width: listWidth })}
      >
        {list}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        {reader}
      </box>
    </box>
  );
}
