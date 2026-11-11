import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Application } from "~/application/application";
import { ApplicationProvider } from "~/application/react";
import type { EngineClient } from "~/packaging/engine/client";
import { followSourceFonts } from "~/workspace/browser-fonts";
import { WorkspaceProvider } from "~/workspace/react";
import { ServicesProvider } from "~/workspace/services";
import type { Workspace } from "~/workspace/workspace";
import { testWorkspace } from "../../helpers/workspace";

/** An engine that never starts. These screens read fonts, they do not build them. */
const idleEngine = {
  status: () => "idle",
  subscribe: () => () => undefined,
} as unknown as EngineClient;

/**
 * Renders a screen the way the app does, over a real workspace. No browser
 * font is ever registered, so text in a face is drawn from its outlines.
 */
export const renderScreen = (
  screen: ReactNode,
  workspace: Workspace = testWorkspace()
) => {
  const fonts = followSourceFonts(workspace, {
    add: () => undefined,
    remove: () => undefined,
  });
  const view = render(
    <WorkspaceProvider workspace={workspace}>
      <ServicesProvider services={{ engine: idleEngine, fonts }}>
        {screen}
      </ServicesProvider>
    </WorkspaceProvider>
  );
  return { ...view, workspace };
};

/**
 * Renders a screen that reaches the application, over the application the
 * test opened and its workspace.
 */
export const renderInApplication = (
  screen: ReactNode,
  application: Application
) =>
  renderScreen(
    <ApplicationProvider application={application}>
      {screen}
    </ApplicationProvider>,
    application.workspace
  );
