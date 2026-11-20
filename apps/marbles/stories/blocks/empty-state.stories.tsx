import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { EmptyState } from "~/components/blocks/empty-state";
import { Text } from "~/components/ui/text";
import { renderFrame } from "../frame";

const size = { height: 6, width: 60 };

function Resettable() {
  const [resets, setResets] = useState(0);
  const reset = useCallback(() => setResets((previous) => previous + 1), []);
  return (
    <>
      <EmptyState
        description="Try another search or clear filters."
        onReset={reset}
        title="No matching runs."
      />
      <Text>Cleared {resets} times</Text>
    </>
  );
}

export default defineStories({
  component: "EmptyState",
  description:
    "A title and hint for an empty list, with an optional Clear filters action.",
  title: "Blocks/EmptyState",
});

export const Empty = story({
  description: "Nothing recorded yet, with a hint on how to add something.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <EmptyState
        description="Steps publish results and milestones here with feed.post()."
        title="No entries yet."
      />,
      size
    ),
});

export const Filtered = story({
  description:
    "A search that matches nothing; clicking Clear filters counts the resets.",
  name: "Filtered",
  render: (renderer) => renderFrame(renderer, <Resettable />, size),
});

export const LongText = story({
  description: "A long title and description wrap in a narrow column.",
  name: "Long text",
  render: (renderer) =>
    renderFrame(
      renderer,
      <EmptyState
        description="Choose a starter during setup, or add a prebuilt step in .foundry/marbles, then save the file to load it."
        title="No workflows or steps in this workspace yet."
      />,
      { height: 10, width: 30 }
    ),
});
