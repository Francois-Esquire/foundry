/**
 * What the application holds for its screens. There is one rule. A screen is
 * taken down whenever a person looks at another place, so `screen` keeps one
 * session of each place for as long as the application is open. And the
 * open project has one of each thing its places share: the builds of Export
 * and Proof, the variable font, and the model provider's key.
 *
 * This is the only module that makes a session, and it makes them for
 * screens. A command makes none: it calls the operations a session calls.
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
import { DEVANAGARI_OFFERING } from "~/generate/script-extension/offering";
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
  readonly screen: ScreenSessions;
  /**
   * The builder, as far as the Studio asks it: the layout a font file
   * carries. A screen has no other way to the application's means.
   */
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
  const {
    builder,
    clock,
    codec,
    modelFetch,
    newId,
    reader,
    servedRuns,
    timer,
  } = means;
  const builds = createWorkingBuilds();
  const providerKey = createStore(means.providerKey ?? "");

  return {
    export: createExportSession({
      builder,
      charactersOfFace: (faceId) => workspace.openFace(faceId).characters(),
      clock,
      newId,
      reader,
    }),
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
      generate: kept(() =>
        createGenerateSession({
          clock,
          codec,
          modelFetch,
          newId,
          providerKey: providerKey.getState,
          runs: servedRuns,
          timer,
          workspace,
        })
      ),
      reconstruct: kept(() =>
        createReconstructSession({
          builder,
          clock,
          codec,
          modelFetch,
          newId,
          providerKey: providerKey.getState,
          runs: servedRuns,
          workspace,
        })
      ),
      scriptExtension: kept(() =>
        createScriptExtensionSession({
          builder,
          clock,
          codec,
          newId,
          offering: DEVANAGARI_OFFERING,
          reader,
          runs: servedRuns,
          timer,
          workspace,
        })
      ),
    },
    studio: builder,
    variable: createVariableSession({ builder, clock }),
  };
};
