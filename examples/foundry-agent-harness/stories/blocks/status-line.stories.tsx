import { defineStories, story } from "textbook-sh";
import { StatusLine } from "@/components/blocks/status-line";
import { renderFrame } from "../frame";

const size = { height: 3, width: 76 };

export default defineStories({
  component: "StatusLine",
  description: "Tokens used so far and the keys that work.",
  title: "Blocks/StatusLine",
});

export const NewThread = story({
  description: "Nothing spent yet.",
  name: "New thread",
  render: (renderer) =>
    renderFrame(renderer, <StatusLine input={0} output={0} panel />, size),
});

export const Spent = story({
  description: "Large counts are shortened.",
  name: "Spent",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLine input={18_400} output={912} panel />,
      size
    ),
});

export const NoPanel = story({
  description: "A narrow screen has no panel, so Tab is not offered.",
  name: "No panel",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLine input={18_400} output={912} panel={false} />,
      size
    ),
});
