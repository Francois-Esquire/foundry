import { defineStories, story } from "textbook-sh";
import { ThreadHeader } from "@/components/blocks/thread-header";
import { renderFrame } from "../frame";

const size = { height: 3, width: 82 };

export default defineStories({
  component: "ThreadHeader",
  description: "The harness's name, the thread's title, and the model.",
  title: "Blocks/ThreadHeader",
});

export const Roomy = story({
  description: "Everything fits.",
  name: "Roomy",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ThreadHeader model="claude-code/sonnet" title="New thread" width={80} />,
      size
    ),
});

export const LongTitle = story({
  description: "A long title ends with an ellipsis.",
  name: "Long title",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ThreadHeader
        model="claude-code/sonnet"
        title="Read package.json here and explain how to run this example."
        width={80}
      />,
      size
    ),
});

export const Tight = story({
  description: "No room for a title, so only the model is shown.",
  name: "Tight",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ThreadHeader model="claude-code/sonnet" title="New thread" width={46} />,
      size
    ),
});
