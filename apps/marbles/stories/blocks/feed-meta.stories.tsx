import { defineStories, story } from "textbook-sh";
import { feedMeta } from "~/cli/state/feed-model";
import { FeedMetaLine } from "~/components/blocks/feed-meta";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { renderFrame } from "../frame";
import {
  answeredEntry,
  cancelledEntry,
  milestoneEntry,
  pendingEntry,
  summaryEntry,
} from "./fixtures-a";

const size = { height: 3, width: 72 };

function details(entry: FeedEntrySnapshot) {
  return [entry.workspace.name, entry.posted, entry.run, entry.step];
}

export default defineStories({
  component: "FeedMetaLine",
  description:
    "A feed entry's kind, coloured by kind and answer status, followed by its details.",
  title: "Blocks/FeedMetaLine",
});

export const Result = story({
  description: "A result, in the success colour.",
  name: "Result",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(summaryEntry)}
        meta={feedMeta(summaryEntry)}
      />,
      size
    ),
});

export const Milestone = story({
  description: "A milestone, in the info colour.",
  name: "Milestone",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(milestoneEntry)}
        meta={feedMeta(milestoneEntry)}
      />,
      size
    ),
});

export const NeedsInput = story({
  description: "An open question, as a warning badge.",
  name: "Needs input",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(pendingEntry)}
        meta={feedMeta(pendingEntry)}
      />,
      size
    ),
});

export const Answered = story({
  description: "An answered question, in the secondary colour.",
  name: "Answered",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(answeredEntry)}
        meta={feedMeta(answeredEntry)}
      />,
      size
    ),
});

export const Cancelled = story({
  description: "A question whose run stopped first, in the secondary colour.",
  name: "Cancelled",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(cancelledEntry)}
        meta={feedMeta(cancelledEntry)}
      />,
      size
    ),
});

export const MissingDetails = story({
  description: "Empty and missing details are left out.",
  name: "Missing details",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={[undefined, summaryEntry.posted, "", undefined]}
        meta={feedMeta(summaryEntry)}
      />,
      size
    ),
});

export const Wrapped = story({
  description: "Details that do not fit wrap onto the next line.",
  name: "Wrapped",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedMetaLine
        details={details(pendingEntry)}
        meta={feedMeta(pendingEntry)}
      />,
      { height: 5, width: 30 }
    ),
});
