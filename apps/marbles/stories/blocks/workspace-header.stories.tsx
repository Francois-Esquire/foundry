import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { Text } from "~/components/ui/text";
import type { WorkspaceState } from "~/model/connection";
import { ignore, renderFrame } from "../frame";

const size = { height: 4, width: 70 };

function stateStory(state: WorkspaceState) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(
      renderer,
      <WorkspaceHeader
        onHome={ignore}
        onWorkspaces={ignore}
        state={state}
        workspace="foundry"
      />,
      size
    );
}

function Navigate() {
  const [last, setLast] = useState("Click marbles or the workspace name.");
  const home = useCallback(() => setLast("Went home"), []);
  const workspaces = useCallback(
    () => setLast("Opened the workspaces drawer"),
    []
  );
  return (
    <>
      <WorkspaceHeader
        onHome={home}
        onWorkspaces={workspaces}
        state="ready"
        workspace="foundry"
      />
      <Text>{last}</Text>
    </>
  );
}

export default defineStories({
  component: "WorkspaceHeader",
  description:
    "The top line: marbles, the workspace with its picker, and the host's state on the right.",
  title: "Blocks/WorkspaceHeader",
});

export const Navigation = story({
  description: "Click marbles to go home or the workspace to open the picker.",
  name: "Navigation",
  render: (renderer) =>
    renderFrame(renderer, <Navigate />, { height: 5, width: 70 }),
});

export const SingleWorkspace = story({
  description:
    "A dashboard with no picker shows the workspace name in bold and no state.",
  name: "Single workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspaceHeader onHome={ignore} workspace="foundry" />,
      size
    ),
});

export const Ready = story({
  description: "A ready host shows no state label.",
  name: "Ready",
  render: stateStory("ready"),
});

export const Starting = story({
  description: "A host still starting.",
  name: "Starting",
  render: stateStory("starting"),
});

export const Reloading = story({
  description: "A host reloading after a source change.",
  name: "Reloading",
  render: stateStory("reloading"),
});

export const Failed = story({
  description: "A host that failed to load, in the error colour.",
  name: "Failed",
  render: stateStory("failed"),
});

export const Stopped = story({
  description: "A host that has stopped.",
  name: "Stopped",
  render: stateStory("stopped"),
});

export const Narrow = story({
  description:
    "A long workspace name in a narrow terminal truncates; the state stays whole.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkspaceHeader
        onHome={ignore}
        onWorkspaces={ignore}
        state="reloading"
        workspace="handbook/internal-tools"
      />,
      { height: 4, width: 34 }
    ),
});
