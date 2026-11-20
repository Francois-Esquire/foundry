import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { DashboardFooter } from "~/components/blocks/dashboard-footer";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "../frame";

const shortcuts = "? Help · / Search · q Quit";

function ClickableFooter() {
  const [opened, setOpened] = useState("nothing yet");
  const open = useCallback((label: string) => () => setOpened(label), []);
  return (
    <>
      <DashboardFooter
        onDiagnostics={open("Diagnostics")}
        onSettings={open("Settings")}
        onWorkspaces={open("Workspaces")}
        shortcuts={shortcuts}
      />
      <Text>Opened: {opened}</Text>
    </>
  );
}

export default defineStories({
  component: "DashboardFooter",
  description:
    "The bottom row: drawer actions on the left, lasting shortcuts and Settings on the right.",
  title: "Blocks/DashboardFooter",
});

export const Default = story({
  description: "Every action, as when the dashboard hosts several workspaces.",
  name: "Default",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DashboardFooter
        onDiagnostics={ignore}
        onSettings={ignore}
        onWorkspaces={ignore}
        shortcuts={shortcuts}
      />,
      { height: 3, width: 100 }
    ),
});

export const WithoutWorkspaces = story({
  description: "A host without a workspace list leaves out that action.",
  name: "Without workspaces",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DashboardFooter
        onDiagnostics={ignore}
        onSettings={ignore}
        shortcuts={shortcuts}
      />,
      { height: 3, width: 100 }
    ),
});

export const Narrow = story({
  description:
    "A narrow terminal moves the shortcuts and Settings onto their own row, cutting off shortcuts that still do not fit.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <DashboardFooter
        onDiagnostics={ignore}
        onSettings={ignore}
        onWorkspaces={ignore}
        shortcuts="? Help · / Search · f Filter runs · x Clear · q Quit"
      />,
      { height: 4, width: 56 }
    ),
});

export const Clickable = story({
  description: "Click an action to see which drawer it opens.",
  name: "Clickable",
  render: (renderer) =>
    renderFrame(renderer, <ClickableFooter />, { height: 5, width: 100 }),
});
