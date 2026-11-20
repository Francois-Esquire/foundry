import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "./frame";

const size = { height: 7, width: 40 };

const tree = [
  { depth: 0, name: "nightly-digest" },
  { depth: 1, name: "fetch-prs" },
  { depth: 1, name: "summarise" },
  { depth: 2, name: "ask-model" },
  { depth: 0, name: "triage-issues" },
];

function ClickableRows() {
  const [selected, setSelected] = useState("summarise");
  return (
    <box flexDirection="column">
      {tree.map((row) => (
        <SelectableRow
          depth={row.depth}
          id={`row-story:${row.name}`}
          key={row.name}
          onSelect={setSelected}
          selected={row.name === selected}
          value={row.name}
        >
          <Text>{row.name}</Text>
        </SelectableRow>
      ))}
    </box>
  );
}

export default defineStories({
  component: "SelectableRow",
  description: "A clickable list row with a selection marker and indent.",
  title: "UI/SelectableRow",
});

export const Unselected = story({
  description: "A row that is not selected.",
  name: "Unselected",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SelectableRow
        id="row-story:plain"
        onSelect={ignore}
        selected={false}
        value="nightly-digest"
      >
        <Text>nightly-digest</Text>
      </SelectableRow>,
      size
    ),
});

export const Selected = story({
  description: "A selected row with the marker and muted background.",
  name: "Selected",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SelectableRow
        id="row-story:selected"
        onSelect={ignore}
        selected
        value="nightly-digest"
      >
        <Text>nightly-digest</Text>
      </SelectableRow>,
      size
    ),
});

export const NestedRows = story({
  description:
    "Rows indented by depth, as in the run tree; click a row to select it.",
  name: "Nested rows",
  render: (renderer) => renderFrame(renderer, <ClickableRows />, size),
});
