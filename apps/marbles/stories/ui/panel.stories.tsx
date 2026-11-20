import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Action } from "~/components/ui/action";
import { Panel, type PanelHints, PanelShortcuts } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "./frame";

const size = { height: 10, width: 60 };

const workflows = [
  "nightly-digest",
  "triage-issues",
  "summarise-prs",
  "tidy-branches",
];

const steps = Array.from({ length: 20 }, (_, index) => `step-${index + 1}`);

const hints: PanelHints = {
  actions: [
    { label: "Enter open" },
    { label: "/ search", priority: true },
    { label: "f filter runs" },
    { label: "x clear" },
  ],
  focus: "Marbles",
};

function WorkflowRows() {
  return workflows.map((name) => <Text key={name}>{name}</Text>);
}

function StepRows({ selected }: { readonly selected?: string }) {
  return steps.map((name) => (
    <SelectableRow
      id={`panel-story:${name}`}
      key={name}
      onSelect={ignore}
      selected={name === selected}
      value={name}
    >
      <Text>{name}</Text>
    </SelectableRow>
  ));
}

function FollowSelection() {
  const [index, setIndex] = useState(0);
  const [resets, setResets] = useState(0);
  useKeyboard((key) => {
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const step = key.name === "down" ? 1 : -1;
      setIndex((previous) =>
        Math.max(0, Math.min(steps.length - 1, previous + step))
      );
    }
  });
  const selected = steps[index] ?? "";
  return (
    <Panel
      active
      borderHint=" ↑↓ select "
      header={
        <box flexDirection="row" gap={2}>
          <Text>Selected {selected}</Text>
          <Action
            id="panel-story:top"
            label="[ Scroll to top ]"
            onAction={setResets}
            value={resets + 1}
          />
        </box>
      }
      resetKey={`reset:${resets}`}
      selectedId={`panel-story:${selected}`}
      title="Steps"
    >
      <StepRows selected={selected} />
    </Panel>
  );
}

export default defineStories({
  component: "Panel",
  description:
    "A bordered, titled, scrolling region; active panels show focus and hints.",
  title: "UI/Panel",
});

export const Inactive = story({
  description: "An inactive panel with the plain border and no hints.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel id="panel:marbles" title="Marbles">
        <WorkflowRows />
      </Panel>,
      size
    ),
});

export const Active = story({
  description: "An active panel with the focus border colour.",
  name: "Active",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel active title="Marbles">
        <WorkflowRows />
      </Panel>,
      size
    ),
});

export const BorderHint = story({
  description: "An active panel showing a fixed hint in its bottom border.",
  name: "Border hint",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel active borderHint=" Enter open · Esc back " title="Marbles">
        <WorkflowRows />
      </Panel>,
      size
    ),
});

export const Shortcuts = story({
  description: "Hints from PanelShortcuts; a wide panel fits every shortcut.",
  name: "Shortcuts",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PanelShortcuts.Provider value={hints}>
        <Panel active title="Marbles">
          <WorkflowRows />
        </Panel>
      </PanelShortcuts.Provider>,
      { height: 10, width: 70 }
    ),
});

export const NarrowShortcuts = story({
  description:
    "The same hints in a narrow panel keep only the priority shortcut.",
  name: "Narrow shortcuts",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PanelShortcuts.Provider value={hints}>
        <Panel active title="Marbles">
          <WorkflowRows />
        </Panel>
      </PanelShortcuts.Provider>,
      { height: 10, width: 30 }
    ),
});

export const InactiveWithShortcuts = story({
  description: "Shortcut hints are hidden while the panel is inactive.",
  name: "Inactive with shortcuts",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PanelShortcuts.Provider value={hints}>
        <Panel title="Marbles">
          <WorkflowRows />
        </Panel>
      </PanelShortcuts.Provider>,
      size
    ),
});

export const Header = story({
  description: "A fixed header above the scrolling body.",
  name: "Header",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel
        header={
          <text fg={theme.colors.mutedForeground}>Search: dig · 1 of 4</text>
        }
        title="Marbles"
      >
        <Text>nightly-digest</Text>
      </Panel>,
      size
    ),
});

export const SelectedRow = story({
  description: "A long list scrolled so the selected row is in view.",
  name: "Selected row",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel active selectedId="panel-story:step-16" title="Steps">
        <StepRows selected="step-16" />
      </Panel>,
      size
    ),
});

export const Scrollable = story({
  description: "A scrollable panel; arrows scroll its body directly.",
  name: "Scrollable",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Panel active scrollable title="Steps">
        <StepRows />
      </Panel>,
      size
    ),
});

export const FollowAndReset = story({
  description:
    "Arrows move the selection and the panel follows; the action resets the scroll.",
  name: "Follow and reset",
  render: (renderer) => renderFrame(renderer, <FollowSelection />, size),
});
