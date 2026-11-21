import { defineStories, story } from "textbook-sh";
import { Welcome as WelcomeBlock } from "@/components/blocks/welcome";
import { renderFrame } from "../frame";

const size = { height: 14, width: 76 };

export default defineStories({
  component: "Welcome",
  description: "What a goal does, shown before the first one.",
  title: "Blocks/Welcome",
});

export const Welcome = story({
  description: "The steps and two example goals.",
  name: "Welcome",
  render: (renderer) => renderFrame(renderer, <WelcomeBlock />, size),
});
