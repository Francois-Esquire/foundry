import { defineStories, story } from "textbook-sh";
import { Spinner } from "@/components/blocks/spinner";
import { renderFrame } from "../frame";

const size = { height: 3, width: 12 };

export default defineStories({
  component: "Spinner",
  description: "One frame of the spinner. The view's clock picks the frame.",
  title: "Blocks/Spinner",
});

export const First = story({
  description: "The first frame.",
  name: "First frame",
  render: (renderer) => renderFrame(renderer, <Spinner frame={0} />, size),
});

export const Later = story({
  description: "A later frame.",
  name: "Later frame",
  render: (renderer) => renderFrame(renderer, <Spinner frame={5} />, size),
});

export const Wrapped = story({
  description: "A frame past the last one wraps around.",
  name: "Wrapped",
  render: (renderer) => renderFrame(renderer, <Spinner frame={12} />, size),
});
