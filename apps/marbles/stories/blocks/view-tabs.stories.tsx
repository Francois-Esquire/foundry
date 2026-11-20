import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { type ViewTabItem, ViewTabs } from "~/components/blocks/view-tabs";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "../frame";

type View = "overview" | "catalog" | "feed";

const views: readonly ViewTabItem<View>[] = [
  { label: "Dashboard", view: "overview" },
  { label: "Catalog", view: "catalog" },
  { label: "Feed", view: "feed" },
];

const descriptions: Record<View, string> = {
  catalog: "Triggers and marbles, with details beside them.",
  feed: "Results and questions posted by runs.",
  overview: "Metrics, the latest activity, and the run list.",
};

function SwitchableViews() {
  const [view, setView] = useState<View>("overview");
  return (
    <>
      <ViewTabs onChange={setView} tabs={views} view={view} />
      <Text>{descriptions[view]}</Text>
    </>
  );
}

export default defineStories({
  component: "ViewTabs",
  description:
    "The dashboard's view switcher; the active view is bold in the primary colour.",
  title: "Blocks/ViewTabs",
});

export const ClickToSwitch = story({
  description: "Click a view name to make it active.",
  name: "Click to switch",
  render: (renderer) =>
    renderFrame(renderer, <SwitchableViews />, { height: 6, width: 60 }),
});

export const CatalogActive = story({
  description: "The catalog view active, as after Shift+C.",
  name: "Catalog active",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ViewTabs onChange={ignore} tabs={views} view="catalog" />,
      { height: 4, width: 60 }
    ),
});

export const FeedActive = story({
  description: "The last view active.",
  name: "Feed active",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ViewTabs onChange={ignore} tabs={views} view="feed" />,
      { height: 4, width: 60 }
    ),
});

export const Narrow = story({
  description:
    "Tabs neither shrink nor wrap, so in a narrow frame they run past its edge.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ViewTabs onChange={ignore} tabs={views} view="overview" />,
      { height: 4, width: 22 }
    ),
});
