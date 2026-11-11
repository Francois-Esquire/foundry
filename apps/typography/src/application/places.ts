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
import { createStore, type Store } from "~/lib/store";
import type { FontBuilder } from "~/packaging/building";
import { type Proof, proveFont } from "~/proof/proof";
import type { ProofFont } from "~/proof/proof-subject";
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

/**
 * The Proof place: its working builds and the proof of a built font, made
 * with the application's builder, reader, clock and ids.
 */
interface ProofPlace extends Pick<WorkingBuilds, "of" | "subscribe"> {
  /**
   * Reopens a built font and compares it with its source. Rejects when the
   * font does not reopen, or its face has left the project since it was built.
   */
  prove(font: ProofFont): Promise<Proof>;
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
  readonly proof: ProofPlace;
  /**
   * The model provider's key, held once for every place that calls a model.
   * It starts as the key the application was opened with, a person can type
   * another, and a strategy reads it when it runs. In memory only.
   */
  readonly providerKey: Pick<
    Store<string>,
    "getState" | "setState" | "subscribe"
  >;
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
  /** What the Studio place asks the font engine: the layout a font file carries. */
  readonly studio: Pick<FontBuilder, "describeLayout">;
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
  const { builder, clock, codec, modelFetch, newId, reader, timer } = means;
  const builds = createWorkingBuilds();
  const providerKey = createStore(means.providerKey ?? "");

  const generate = ({ base, fetch }: RecordedRuns) =>
    createGenerateSession({
      base,
      clock,
      codec,
      fetch,
      modelFetch,
      newId,
      providerKey: providerKey.getState,
      timer,
      workspace,
    });
  /** Without `defer`, a reading follows the next drawing of the screen. */
  const reconstruct = (
    { base, fetch }: RecordedRuns,
    defer?: (work: () => void) => void
  ) =>
    createReconstructSession({
      base,
      builder,
      clock,
      codec,
      defer,
      fetch,
      modelFetch,
      newId,
      providerKey: providerKey.getState,
      workspace,
    });
  const scriptExtension = (
    offering: ExtensionOffering,
    { base, fetch }: RecordedRuns
  ) =>
    createScriptExtensionSession({
      base,
      builder,
      clock,
      codec,
      fetch,
      newId,
      offering,
      reader,
      timer,
      workspace,
    });

  return {
    export: createExportSession({
      builder,
      charactersOfFace: (faceId) => workspace.openFace(faceId).characters(),
      clock,
      newId,
      reader,
    }),
    generate,
    proof: {
      of: builds.of,
      prove: async (font) =>
        proveFont({
          builder,
          bytes: font.bytes,
          reader,
          request: font.request,
          samples: font.samples.map((entry) => entry.sample),
          source: workspace.openFace(font.faceId),
        }),
      start: (faceId, label) =>
        builds.start(faceId, () =>
          buildWorkingFace({ builder, clock, faceId, label, newId, workspace })
        ),
      subscribe: builds.subscribe,
    },
    providerKey,
    reconstruct,
    screen: {
      family: kept(() =>
        createFamilySession({
          clock,
          codec,
          modelFetch,
          newId,
          providerKey: providerKey.getState,
          workspace,
        })
      ),
      generate: kept(() => generate(means.servedRuns)),
      reconstruct: kept(() => reconstruct(means.servedRuns)),
      scriptExtension: kept(() =>
        scriptExtension(DEVANAGARI_OFFERING, means.servedRuns)
      ),
    },
    scriptExtension,
    studio: {
      describeLayout: (font, faceIndex) =>
        builder.describeLayout(font, faceIndex),
    },
    variable: createVariableSession({ builder, clock }),
  };
};
