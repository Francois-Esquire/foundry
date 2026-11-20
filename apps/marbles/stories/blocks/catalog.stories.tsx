import { useCallback, useMemo, useState } from "react";
import { defineStories, story } from "textbook-sh";
import {
  type DashboardSelection,
  selectionKey,
} from "~/cli/state/dashboard-model";
import {
  type DefinitionRow,
  DefinitionsBlock,
  type TriggerRow,
  TriggersBlock,
} from "~/components/blocks/catalog";
import { ignore, renderFrame } from "../frame";
import {
  definitionItems,
  longDefinitionItems,
  triggerItems,
} from "./fixtures-a";

const size = { height: 9, padded: false, width: 96 };

function selectedId<
  T extends { readonly id: string; readonly selected: boolean },
>(items: readonly T[]): string | undefined {
  return items.find((item) => item.selected)?.id;
}

function reselect<
  T extends TriggerRow<DashboardSelection> | DefinitionRow<DashboardSelection>,
>(items: readonly T[], key: string | undefined): T[] {
  return items.map((item) => ({
    ...item,
    selected: selectionKey(item.selection) === key,
  }));
}

function SelectableTriggers() {
  const [key, setKey] = useState<string>();
  const items = useMemo(() => reselect(triggerItems, key), [key]);
  const select = useCallback(
    (selection: DashboardSelection) => setKey(selectionKey(selection)),
    []
  );
  return (
    <TriggersBlock
      active
      items={items}
      onSelect={select}
      selectedId={selectedId(items)}
    />
  );
}

function SelectableDefinitions() {
  const [key, setKey] = useState<string>();
  const items = useMemo(() => reselect(definitionItems, key), [key]);
  const select = useCallback(
    (selection: DashboardSelection) => setKey(selectionKey(selection)),
    []
  );
  return (
    <DefinitionsBlock
      active
      items={items}
      onSelect={select}
      selectedId={selectedId(items)}
      workspace="foundry"
    />
  );
}

export default defineStories({
  component: "TriggersBlock, DefinitionsBlock",
  description:
    "The catalog's two panels: triggers with their status, and the workflows and steps they run.",
  title: "Blocks/Catalog",
});

export const Triggers = story({
  description:
    "Schedules and monitors with kind, status, and detail; the schedule is selected.",
  name: "Triggers",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock
        active
        items={triggerItems}
        onSelect={ignore}
        selectedId={selectedId(triggerItems)}
      />,
      size
    ),
});

export const TriggersCompact = story({
  description:
    "Triggers beside the details panel: the detail column is dropped and names fill the row.",
  name: "Triggers compact",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock
        active
        compact
        items={triggerItems}
        onSelect={ignore}
        selectedId={selectedId(triggerItems)}
      />,
      { ...size, width: 40 }
    ),
});

export const TriggersNarrow = story({
  description:
    "A narrow panel keeps each trigger's name and status whole and truncates its detail.",
  name: "Triggers narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock
        active
        items={triggerItems}
        onSelect={ignore}
        selectedId={selectedId(triggerItems)}
      />,
      { ...size, width: 48 }
    ),
});

export const TriggersInactive = story({
  description: "Triggers while another panel has focus.",
  name: "Triggers inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock active={false} items={triggerItems} onSelect={ignore} />,
      size
    ),
});

export const TriggersEmpty = story({
  description: "No schedules or monitors yet, with a hint on adding one.",
  name: "Triggers empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock active items={[]} onSelect={ignore} />,
      size
    ),
});

export const TriggersNoMatch = story({
  description: "A search that matches no trigger, with a Clear filters action.",
  name: "Triggers no match",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TriggersBlock
        active
        items={[]}
        onReset={ignore}
        onSelect={ignore}
        searching
      />,
      size
    ),
});

export const ClickTriggers = story({
  description: "Click a trigger row to select it.",
  name: "Click triggers",
  render: (renderer) => renderFrame(renderer, <SelectableTriggers />, size),
});

export const Definitions = story({
  description:
    "Workflows and steps with their source location; update-documentation is selected.",
  name: "Definitions",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DefinitionsBlock
        active
        items={definitionItems}
        onSelect={ignore}
        selectedId={selectedId(definitionItems)}
        workspace="foundry"
      />,
      size
    ),
});

export const DefinitionsCompact = story({
  description:
    "Compact definitions: a short title and no source column, as beside details.",
  name: "Definitions compact",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DefinitionsBlock
        active
        compact
        items={definitionItems}
        onSelect={ignore}
        selectedId={selectedId(definitionItems)}
        workspace="foundry"
      />,
      { ...size, width: 40 }
    ),
});

export const DefinitionsLongNames = story({
  description:
    "A long name and source, and a step from outside the workspace, truncated in a narrow panel.",
  name: "Definitions long names",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DefinitionsBlock
        active
        items={longDefinitionItems}
        onSelect={ignore}
        workspace="foundry"
      />,
      { height: 10, padded: false, width: 60 }
    ),
});

export const DefinitionsEmpty = story({
  description: "No workflows or steps yet, with a hint on adding one.",
  name: "Definitions empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DefinitionsBlock
        active
        items={[]}
        onSelect={ignore}
        workspace="foundry"
      />,
      size
    ),
});

export const DefinitionsNoMatch = story({
  description: "A search that matches nothing, with a Clear filters action.",
  name: "Definitions no match",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DefinitionsBlock
        active
        items={[]}
        onReset={ignore}
        onSelect={ignore}
        searching
        workspace="foundry"
      />,
      size
    ),
});

export const ClickDefinitions = story({
  description: "Click a definition row to select it.",
  name: "Click definitions",
  render: (renderer) => renderFrame(renderer, <SelectableDefinitions />, size),
});
