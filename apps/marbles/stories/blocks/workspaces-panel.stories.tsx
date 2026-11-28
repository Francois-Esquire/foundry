import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { WorkspacesPanel } from "~/components/blocks/workspaces-panel";
import type { WorkspaceSummary } from "~/model/connection";
import { workspaceDetails, workspaceRows } from "~/tui/state/dashboard-rows";
import { ignore, renderFrame } from "../frame";
import { workspaceSummaries } from "./fixtures-b";

const drawer = { height: 18, width: 46 };
const rail = { height: 18, padded: false, width: 26 };

const rows = workspaceRows(workspaceSummaries);

const twins: readonly WorkspaceSummary[] = [
  {
    config: ".foundry/marbles",
    id: "ws-app-client",
    root: "/Users/sam/code/client/app",
    state: "ready",
  },
  {
    config: ".foundry/marbles",
    id: "ws-app-server",
    root: "/Users/sam/code/server/app",
    state: "reloading",
  },
  {
    config: ".foundry/marbles",
    id: "ws-foundry",
    root: "/Users/sam/code/foundry",
    state: "ready",
  },
];

const ids = workspaceSummaries.map((workspace) => workspace.id);

function Pick({ compact = false }: { readonly compact?: boolean }) {
  const [selected, setSelected] = useState("ws-foundry");
  useKeyboard((key) => {
    if (key.name !== "up" && key.name !== "down") {
      return;
    }
    key.preventDefault();
    const index = ids.indexOf(selected) + (key.name === "down" ? 1 : -1);
    setSelected(ids[index] ?? selected);
  });
  return (
    <WorkspacesPanel
      compact={compact}
      current="ws-foundry"
      details={
        compact ? undefined : workspaceDetails(workspaceSummaries, selected)
      }
      onSelect={setSelected}
      selected={selected}
      workspaces={rows}
    />
  );
}

export default defineStories({
  component: "WorkspacesPanel",
  description:
    "The workspaces list, as the drawer with details or the compact rail beside the dashboard.",
  title: "Blocks/WorkspacesPanel",
});

export const Drawer = story({
  description:
    "Up, Down, or a click select a workspace; the selected one's root and error show below.",
  name: "Drawer",
  render: (renderer) => renderFrame(renderer, <Pick />, drawer),
});

export const Rail = story({
  description:
    "The compact rail: no details, an unfocused border, and a state that moves below a name it does not fit beside.",
  name: "Rail",
  render: (renderer) => renderFrame(renderer, <Pick compact />, rail),
});

export const FailedSelected = story({
  description: "A failed workspace selected shows its load error.",
  name: "Failed workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspacesPanel
        current="ws-foundry"
        details={workspaceDetails(workspaceSummaries, "ws-site")}
        onSelect={ignore}
        selected="ws-site"
        workspaces={rows}
      />,
      drawer
    ),
});

export const QualifiedNames = story({
  description:
    "Workspaces with the same folder name get their parent folder in the label.",
  name: "Qualified names",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspacesPanel
        current="ws-app-client"
        details={workspaceDetails(twins, "ws-app-server")}
        onSelect={ignore}
        selected="ws-app-server"
        workspaces={workspaceRows(twins)}
      />,
      drawer
    ),
});

export const QualifiedRail = story({
  description:
    "In the rail a qualified label puts its state on the line below.",
  name: "Qualified names, rail",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspacesPanel
        compact
        current="ws-app-client"
        onSelect={ignore}
        selected="ws-app-client"
        workspaces={workspaceRows(twins)}
      />,
      rail
    ),
});

export const OneWorkspace = story({
  description: "A single workspace, current and selected.",
  name: "One workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspacesPanel
        current="ws-foundry"
        details={workspaceDetails(workspaceSummaries, "ws-foundry")}
        onSelect={ignore}
        selected="ws-foundry"
        workspaces={rows.slice(0, 1)}
      />,
      { height: 10, width: 46 }
    ),
});

export const Empty = story({
  description: "No registered workspaces leaves the panel empty.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspacesPanel onSelect={ignore} selected="" workspaces={[]} />,
      { height: 8, width: 46 }
    ),
});
