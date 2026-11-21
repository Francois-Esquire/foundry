import { defineStories, story } from "textbook-sh";
import { Reply } from "@/components/blocks/reply";
import { threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 12, width: 70 };

export default defineStories({
  component: "Reply",
  description: "A task's reply, rendered from Markdown.",
  title: "Blocks/Reply",
});

export const Finished = story({
  description: "Inline code, a list, bold text, and a code block.",
  name: "Finished",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reply
        markdown={threads.done.messages[1]?.text ?? ""}
        streaming={false}
      />,
      size
    ),
});

export const Streaming = story({
  description: "The first part of a reply that is still arriving.",
  name: "Streaming",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reply
        markdown={(threads.done.messages[1]?.text ?? "").slice(0, 120)}
        streaming
      />,
      size
    ),
});
