/**
 * The use cases of each place, made with the application's means. A place's
 * session lists its recorded runs once and keeps what it has read, so a
 * screen makes its session and keeps it, and a command makes one for the run
 * it was given. Both then run the same use cases with the same reader,
 * builder, codec, clock and ids.
 */
import { type ExportSession, exportSessionOf } from "~/export/session";
import type { ExtensionOffering } from "~/generate/script-extension/offering";
import {
  createScriptExtensionSession,
  type ScriptExtensionSession,
} from "~/generate/script-extension/session";
import {
  createGenerateSession,
  type GenerateSession,
} from "~/generate/session";
import {
  createReconstructSession,
  type ReconstructSession,
} from "~/reconstruct/session";
import type { Workspace } from "~/workspace/workspace";
import type { ApplicationMeans } from "./means";
import type { RecordedRuns } from "./served-run";

export interface Places {
  /** The Export place's session. One for the open project, as Proof reads it too. */
  readonly export: ExportSession;
  generate(runs: RecordedRuns): GenerateSession;
  /**
   * `defer` runs a reading of the region once the caller is ready for it. A
   * screen leaves it out, and the reading follows the next drawing.
   */
  reconstruct(
    runs: RecordedRuns,
    defer?: (work: () => void) => void
  ): ReconstructSession;
  scriptExtension(
    offering: ExtensionOffering,
    runs: RecordedRuns
  ): ScriptExtensionSession;
}

export const placesOf = (
  means: ApplicationMeans,
  workspace: Workspace
): Places => {
  const clock = () => new Date(means.now());
  /** A session times its steps in milliseconds, read from the same clock. */
  const now = () => Date.parse(means.now());
  const { codec, newId } = means;
  return {
    export: exportSessionOf(workspace),
    generate: ({ base, fetch }) => {
      const session = createGenerateSession({
        base,
        clock,
        codec,
        fetch,
        modelFetch: means.modelFetch,
        newId,
        now,
        workspace,
      });
      session.setProviderKey(means.providerKey ?? "");
      return session;
    },
    reconstruct: ({ base, fetch }, defer) => {
      const session = createReconstructSession({
        base,
        builder: means.builder,
        clock,
        codec,
        defer,
        fetch,
        modelFetch: means.modelFetch,
        newId,
        workspace,
      });
      session.updateCompletionDraft({ providerKey: means.providerKey ?? "" });
      return session;
    },
    scriptExtension: (offering, { base, fetch }) =>
      createScriptExtensionSession({
        base,
        clock,
        codec,
        fetch,
        newId,
        now,
        offering,
        workspace,
      }),
  };
};
