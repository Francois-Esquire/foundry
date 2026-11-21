import { defineStories, story } from "textbook-sh";
import { Hint } from "@/components/blocks/hint";
import { renderFrame } from "../frame";

const size = { height: 3, width: 60 };

export default defineStories({
  component: "Hint",
  description: "Muted text for explanations and empty states.",
  title: "Blocks/Hint",
});

export const Text = story({
  description: "One line of muted text.",
  name: "Text",
  render: (renderer) =>
    renderFrame(renderer, <Hint>No to-dos yet. A goal is planned.</Hint>, size),
});
