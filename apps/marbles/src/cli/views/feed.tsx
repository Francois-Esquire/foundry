import { FeedList } from "~/components/blocks/feed-list";
import { FeedReader } from "~/components/blocks/feed-reader";
import { FeedLayout } from "~/components/layouts/feed";
import type { FeedModel } from "../state/feed-model";

export function FeedView({
  feed,
  width,
}: {
  readonly feed: FeedModel;
  readonly width: number;
}) {
  return (
    <FeedLayout
      list={<FeedList {...feed.list} />}
      reader={<FeedReader {...feed.reader} />}
      width={width}
    />
  );
}
