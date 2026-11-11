/**
 * The use cases of each place, made with the application's means. This is
 * the only module that makes a place's session, so a screen and a command
 * run the same use cases with the same reader, builder, codec, clock, timer
 * and ids.
 *
 * What differs is how long a session is kept. A session lists its recorded
 * runs once and keeps what it has read. A screen is taken down whenever a
 * person looks at another place, so `screen` holds one session of each place
 * for as long as the application is open. A command is given the recorded
 * run to replay, so it makes a session of its own for that run.
 */
import { createExportSession, type ExportSession } from "~/export/session";
import {
  createVariableSession,
  type VariableSession,
} from "~/export/variable/variable-session";
import {
  createFamilySession,
  type FamilySession,
} from "~/generate/family/family-session";
import {
  DEVANAGARI_OFFERING,
  type ExtensionOffering,
} from "~/generate/script-extension/offering";
import {
  createScriptExtensionSession,
  type ScriptExtensionSession,
} from "~/generate/script-extension/session";
import {
  createGenerateSession,
  type GenerateSession,
} from "~/generate/session";
import { buildWorkingFace } from "~/proof/working-build";
import {
  createWorkingBuilds,
  type WorkingBuilds,
} from "~/proof/working-builds";
import {
  createReconstructSession,
  type ReconstructSession,
} from "~/reconstruct/session";
import type { FaceId } from "~/typeface/face";
import type { Workspace } from "~/workspace/workspace";
import type { ApplicationMeans } from "./means";
import type { RecordedRuns } from "./served-run";

/** The Proof place's working builds, built with the application's builder, clock and ids. */
interface ProofBuilds extends Pick<WorkingBuilds, "of" | "subscribe"> {
  /**
   * Starts building a face as the project has it now and returns true. While
   * that face's build is running it starts nothing and returns false. `label`
   * is what the face is called, which the built font is named after.
   */
  start(faceId: FaceId, label: string): boolean;
}

/** The one session of each place a screen holds, made the first time it is asked for. */
interface ScreenSessions {
  /** The coordinated runs of the Generate place. */
  family(): FamilySession;
  generate(): GenerateSession;
  reconstruct(): ReconstructSession;
  /** The script extension on offer, replayed from the recorded runs served with the app. */
  scriptExtension(): ScriptExtensionSession;
}

export interface Places {
  /** The Export place's session. One for the open project, as Proof reads it too. */
  readonly export: ExportSession;
  /** A session for one command, over the recorded run it was given. */
  generate(runs: RecordedRuns): GenerateSession;
  readonly proof: ProofBuilds;
  /**
   * A session for one command. `defer` runs a reading of the region once the
   * caller is ready for it.
   */
  reconstruct(
    runs: RecordedRuns,
    defer: (work: () => void) => void
  ): ReconstructSession;
  readonly screen: ScreenSessions;
  /** A session for one command. */
  scriptExtension(
    offering: ExtensionOffering,
    runs: RecordedRuns
  ): ScriptExtensionSession;
  /** The variable font part of the Export place. One for the open project. */
  readonly variable: VariableSession;
}

/** Makes a session the first time it is asked for and answers with that one from then on. */
const kept = <Session>(make: () => Session): (() => Session) => {
  let session: Session | undefined;
  return () => {
    session ??= make();
    return session;
  };
};

export const placesOf = (
  means: ApplicationMeans,
  workspace: Workspace
): Places => {
  const clock = () => new Date(means.now());
  const { builder, codec, modelFetch, newId, now, reader, timer } = means;
  const builds = createWorkingBuilds();

  const generate = ({ base, fetch }: RecordedRuns) => {
    const session = createGenerateSession({
      base,
      clock,
      codec,
      fetch,
      modelFetch,
      newId,
      now: timer,
      workspace,
    });
    session.setProviderKey(means.providerKey ?? "");
    return session;
  };
  /** Without `defer`, a reading follows the next drawing of the screen. */
  const reconstruct = (
    { base, fetch }: RecordedRuns,
    defer?: (work: () => void) => void
  ) => {
    const session = createReconstructSession({
      base,
      builder,
      clock,
      codec,
      defer,
      fetch,
      modelFetch,
      newId,
      workspace,
    });
    session.updateCompletionDraft({ providerKey: means.providerKey ?? "" });
    return session;
  };
  const scriptExtension = (
    offering: ExtensionOffering,
    { base, fetch }: RecordedRuns
  ) =>
    createScriptExtensionSession({
      base,
      clock,
      codec,
      fetch,
      newId,
      now: timer,
      offering,
      workspace,
    });

  return {
    export: createExportSession({
      builder,
      charactersOfFace: (faceId) => workspace.openFace(faceId).characters(),
      newId,
      now,
      reader,
    }),
    generate,
    proof: {
      of: builds.of,
      start: (faceId, label) =>
        builds.start(faceId, () =>
          buildWorkingFace({ builder, faceId, label, newId, now, workspace })
        ),
      subscribe: builds.subscribe,
    },
    reconstruct,
    screen: {
      family: kept(() =>
        createFamilySession({ clock, codec, modelFetch, newId, workspace })
      ),
      generate: kept(() => generate(means.servedRuns)),
      reconstruct: kept(() => reconstruct(means.servedRuns)),
      scriptExtension: kept(() =>
        scriptExtension(DEVANAGARI_OFFERING, means.servedRuns)
      ),
    },
    scriptExtension,
    variable: createVariableSession({ builder, now }),
  };
};
