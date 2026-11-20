import { defineStories, story } from "textbook-sh";
import { SkillList } from "@/components/blocks/skill-list";
import { context } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 8, width: 44 };

export default defineStories({
  component: "SkillList",
  description: "The skills the worker has.",
  title: "Blocks/SkillList",
});

export const None = story({
  description: "A directory with no skills.",
  name: "None",
  render: (renderer) => renderFrame(renderer, <SkillList skills={[]} />, size),
});

export const Listed = story({
  description: "One skill with its description.",
  name: "Listed",
  render: (renderer) =>
    renderFrame(renderer, <SkillList skills={context.skills} />, size),
});
