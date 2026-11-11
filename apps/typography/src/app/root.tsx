import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { useEffect, useState } from "react";
import { type Application, openApplication } from "~/application/application";
import { ApplicationProvider } from "~/application/react";
import { Refusal } from "~/application/refusal";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { browserImageCodec } from "~/generation/browser-image-codec";
import { createEngineClient } from "~/packaging/engine/client";
import {
  documentFontRegistry,
  followSourceFonts,
} from "~/workspace/browser-fonts";
import { WorkspaceProvider } from "~/workspace/react";
import { type Services, ServicesProvider } from "~/workspace/services";
import { App } from "./app";
import { ProjectNotices } from "./project-notices";
import { ProjectStatus } from "./project-status";
import { UnloadGuard } from "./unload-guard";

interface Session {
  readonly application: Application;
  readonly services: Services;
}

/**
 * One session per page: the application with its open project, the browser
 * fonts that follow it and the font engine. This is the only place the app
 * chooses its engines, its clock, its timer and its ids. The project is kept
 * in memory, so it lasts as long as the page does.
 */
const startSession = async (): Promise<Session> => {
  const engine = createEngineClient();
  const application = await openApplication({
    artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
    builder: engine,
    codec: browserImageCodec,
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    reader: harfBuzzReader,
    readRecordedRun: (location) =>
      Promise.reject(
        new Refusal(
          `The browser cannot read a recorded run from ${location}. It replays the recorded runs served with the app.`
        )
      ),
    servedRuns: {
      base: import.meta.env.BASE_URL,
      fetch: (address) => fetch(address),
    },
    timer: () => performance.now(),
  });
  return {
    application,
    services: {
      engine,
      fonts: followSourceFonts(application.workspace, documentFontRegistry()),
      reader: harfBuzzReader,
    },
  };
};

const stopSession = async ({ application, services }: Session) => {
  services.fonts.stop();
  services.engine.dispose();
  await application.close();
};

/**
 * The session starts in an effect, not in state, so that its cleanup stops the
 * same session it started. React's strict mode runs the cleanup once on mount
 * in development, and a session made in state would be stopped for good. An
 * application opens a moment after it is asked for, so a session whose
 * cleanup has already run is stopped when it arrives and never shown.
 */
export function Root() {
  const [session, setSession] = useState<Session>();
  useEffect(() => {
    let stopped = false;
    const starting = startSession();
    starting.then((started) => {
      if (!stopped) {
        setSession(started);
      }
    });
    return () => {
      stopped = true;
      starting.then(stopSession);
    };
  }, []);
  if (!session) {
    return null;
  }
  return (
    <ApplicationProvider application={session.application}>
      <WorkspaceProvider workspace={session.application.workspace}>
        <ServicesProvider services={session.services}>
          <UnloadGuard />
          <App notices={<ProjectNotices />} status={<ProjectStatus />} />
        </ServicesProvider>
      </WorkspaceProvider>
    </ApplicationProvider>
  );
}
