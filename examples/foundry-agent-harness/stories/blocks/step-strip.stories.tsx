import { defineStories, story } from "textbook-sh";
import { StepStrip } from "@/components/blocks/step-strip";
import type { Step } from "@/model/steps";
import { renderFrame } from "../frame";

const steps: readonly Step[] = [
  { label: "Locate package.json", state: "done" },
  { label: "Identify scripts", state: "done" },
  { label: "Check setup", state: "active" },
  { label: "Summarize", state: "pending" },
];

export default defineStories({
  component: "StepStrip",
  description:
    "The to-dos as keys on a plate: done ones lit green, the active one raised in amber, pending ones sunk.",
  title: "Blocks/StepStrip",
});

export const Roomy = story({
  description: "Every step named, with a lit vent in the spare room.",
  name: "Roomy",
  render: (renderer) =>
    renderFrame(renderer, <StepStrip steps={steps} width={100} />, {
      height: 5,
      width: 102,
    }),
});

export const Tight = story({
  description: "Done steps shrink to their numbers.",
  name: "Tight",
  render: (renderer) =>
    renderFrame(renderer, <StepStrip steps={steps} width={52} />, {
      height: 5,
      width: 54,
    }),
});

export const Narrow = story({
  description: "Only numbers are left.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <StepStrip steps={steps} width={24} />, {
      height: 5,
      width: 26,
    }),
});

export const None = story({
  description: "No steps yet: the bare plate and its vent.",
  name: "None",
  render: (renderer) =>
    renderFrame(renderer, <StepStrip steps={[]} width={40} />, {
      height: 5,
      width: 42,
    }),
});

export const Coarse = story({
  description: "The half-block tier.",
  name: "Coarse",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StepStrip detail="coarse" steps={steps} width={100} />,
      { height: 5, width: 102 }
    ),
});
