import { useEffect } from "react";
import { defineStories, story } from "textbook-sh";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { feedModel } from "~/tui/state/feed-model";
import { type AnswerHandler, useFeed } from "~/tui/state/use-feed";
import { FeedView } from "~/tui/views/feed";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { renderFrame } from "../frame";

const WORKSPACE = "ws-foundry";
const entries = dashboardSnapshot.feed;

const answered: AnswerHandler = () => Promise.resolve();
const pending: AnswerHandler = () => new Promise<void>(() => undefined);
const refused: AnswerHandler = () =>
  Promise.reject(new Error("The run that asked is gone."));

interface FeedStoryProps {
  readonly choose?: string;
  readonly covered?: boolean;
  readonly entries?: readonly FeedEntrySnapshot[];
  readonly onAnswer?: AnswerHandler;
  readonly reader?: boolean;
  readonly scope?: string;
  readonly selected?: string;
  readonly typing?: boolean;
  readonly width: number;
}

function FeedStory({
  choose,
  covered = false,
  entries: shown = entries,
  onAnswer,
  reader = false,
  scope,
  selected,
  typing = false,
  width,
}: FeedStoryProps) {
  const feed = useFeed(shown, WORKSPACE, onAnswer, scope);
  const { answer } = feed;
  const entry = shown.find((item) => item.id === selected);
  useEffect(() => {
    if (entry) {
      feed.select(entry);
    }
    if (reader) {
      feed.read();
    }
    if (typing) {
      answer.start();
    }
    if (choose) {
      answer.choose(choose);
    }
  }, []);
  return <FeedView feed={feedModel(feed, covered)} width={width} />;
}

function rendered(props: FeedStoryProps, height = 24) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, <FeedStory {...props} />, {
      height,
      padded: false,
      width: props.width,
    });
}

export default defineStories({
  component: "FeedView",
  description:
    "The feed of every workspace: entries on the left, the selected entry in the reader.",
  title: "Views/Feed",
});

export const List = story({
  description: "The list has focus; the first entry shows in the reader.",
  name: "List focused",
  render: rendered({ width: 120 }),
});

export const Reader = story({
  description: "A result entry read in the focused reader.",
  name: "Reader focused",
  render: rendered({ reader: true, selected: "feed-summary", width: 120 }),
});

export const Question = story({
  description: "An open question with its choices, when the host can answer.",
  name: "Open question",
  render: rendered({ onAnswer: answered, reader: true, width: 120 }),
});

export const Typing = story({
  description: "Typing a free-form answer to the open question.",
  name: "Typing an answer",
  render: rendered({
    onAnswer: answered,
    reader: true,
    typing: true,
    width: 120,
  }),
});

export const Sending = story({
  description: "A chosen answer that has not been delivered yet.",
  name: "Sending an answer",
  render: rendered({
    choose: "merge",
    onAnswer: pending,
    reader: true,
    width: 120,
  }),
});

export const AnswerFailed = story({
  description: "Delivering the answer failed; the error stays with the entry.",
  name: "Answer failed",
  render: rendered({
    choose: "merge",
    onAnswer: refused,
    reader: true,
    width: 120,
  }),
});

export const Scoped = story({
  description: "Scoped to this workspace; the handbook entry is left out.",
  name: "This workspace only",
  render: rendered({ scope: WORKSPACE, width: 120 }),
});

export const Covered = story({
  description: "Neither side has focus, as when a drawer or dialog is open.",
  name: "Covered",
  render: rendered({ covered: true, width: 120 }),
});

export const Stacked = story({
  description: "At 70 columns the list sits above the reader.",
  name: "Narrow",
  render: rendered({ reader: true, width: 70 }, 30),
});

export const Empty = story({
  description: "No entries yet.",
  name: "Empty",
  render: rendered({ entries: [], width: 120 }),
});
