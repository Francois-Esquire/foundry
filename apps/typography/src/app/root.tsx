import { useEffect, useState } from "react";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { createEngineClient } from "~/packaging/engine/client";
import {
  documentFontRegistry,
  followSourceFonts,
} from "~/workspace/browser-fonts";
import { WorkspaceProvider } from "~/workspace/react";
import { type Services, ServicesProvider } from "~/workspace/services";
import { createWorkspace, type Workspace } from "~/workspace/workspace";
import { App } from "./app";
import { ProjectNotices } from "./project-notices";
import { ProjectStatus } from "./project-status";

interface Session {
  readonly services: Services;
  readonly workspace: Workspace;
}

/**
 * One session per page: the workspace, the browser fonts that follow it and
 * the font engine. This is the only place the app chooses its engines.
 */
const startSession = (): Session => {
  const workspace = createWorkspace({
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    reader: harfBuzzReader,
  });
  return {
    services: {
      engine: createEngineClient(),
      fonts: followSourceFonts(workspace, documentFontRegistry()),
      reader: harfBuzzReader,
    },
    workspace,
  };
};

/**
 * The session starts in an effect, not in state, so that its cleanup stops the
 * same session it started. React's strict mode runs the cleanup once on mount
 * in development, and a session made in state would be stopped for good.
 */
export function Root() {
  const [session, setSession] = useState<Session>();
  useEffect(() => {
    const started = startSession();
    setSession(started);
    return () => {
      started.services.fonts.stop();
      started.services.engine.dispose();
    };
  }, []);
  if (!session) {
    return null;
  }
  return (
    <WorkspaceProvider workspace={session.workspace}>
      <ServicesProvider services={session.services}>
        <App notices={<ProjectNotices />} status={<ProjectStatus />} />
      </ServicesProvider>
    </WorkspaceProvider>
  );
}
