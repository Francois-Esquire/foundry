import { defineStories, story } from "textbook-sh";
import { CostTag } from "~/components/blocks/cost-tag";
import { renderFrame } from "../frame";

const size = { height: 3, width: 30 };

export default defineStories({
  component: "CostTag",
  description:
    "A run's cost: an accent tag when priced, plain muted text when not.",
  title: "Blocks/CostTag",
});

export const Priced = story({
  description: "A reported cost in an accent tag.",
  name: "Priced",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CostTag cost={{ priced: true, value: "$0.12" }} />,
      size
    ),
});

export const Estimated = story({
  description:
    "An estimated cost with a partial marker, still shown as a priced tag.",
  name: "Estimated and partial",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CostTag cost={{ priced: true, value: "~$0.04+?" }} />,
      size
    ),
});

export const Unpriced = story({
  description: "Usage with no known price, shown as muted text.",
  name: "Unpriced",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CostTag cost={{ priced: false, value: "—" }} />,
      size
    ),
});
