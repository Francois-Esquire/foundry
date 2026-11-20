import { defineStories, story } from "textbook-sh";
import { Slab } from "@/components/blocks/slab";
import { renderFrame } from "../frame";

const size = { height: 3, width: 50 };

export default defineStories({
  component: "Slab",
  description:
    "One row for a tool call or its result: a toned label, text, and an optional detail.",
  title: "Blocks/Slab",
});

export const Tool = story({
  description: "A tool call with its time.",
  name: "Tool",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Slab detail="1.2s" label="TOOL" tone="amber">
        Bash bun run --help
      </Slab>,
      size
    ),
});

export const Result = story({
  description: "A result.",
  name: "Result",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Slab label="RESULT" tone="green">
        Two scripts found: start and test.
      </Slab>,
      size
    ),
});

export const Failed = story({
  description: "A failure, clipped to the row.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Slab label="ERROR" tone="red">
        The command exited with status 1 before printing anything useful at all.
      </Slab>,
      size
    ),
});
