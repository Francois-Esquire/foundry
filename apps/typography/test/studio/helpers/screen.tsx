import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { EngineClient } from "~/packaging/engine/client";
import { followSourceFonts } from "~/workspace/browser-fonts";
import { WorkspaceProvider } from "~/workspace/react";
import { ServicesProvider } from "~/workspace/services";
import type { Workspace } from "~/workspace/workspace";

/** An engine that is never asked to start: these tests do not load a layout summary. */
const idleEngine = {
  status: () => "idle",
  subscribe: () => () => undefined,
} as unknown as EngineClient;

/** Renders a Studio screen the way the app does, over a workspace the test holds. */
export const renderInStudio = (screen: ReactNode, workspace: Workspace) => {
  const fonts = followSourceFonts(workspace, {
    add: () => undefined,
    remove: () => undefined,
  });
  return render(
    <WorkspaceProvider workspace={workspace}>
      <ServicesProvider
        services={{ engine: idleEngine, fonts, reader: harfBuzzReader }}
      >
        {screen}
      </ServicesProvider>
    </WorkspaceProvider>
  );
};
