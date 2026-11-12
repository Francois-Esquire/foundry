/**
 * The open project as a command sees it: the workspace, the means, the
 * store, what the open project's places share, and which artifact holds
 * each thing the store keeps for it. Every fact of the project itself is in
 * the workspace's Typeface Project.
 */

import type { SourceId } from "~/typeface/face";
import type { RunMeans } from "~/workspace/run-means";
import type { Workspace } from "~/workspace/workspace";
import type { ApplicationMeans } from "./means";
import type { Places } from "./places";
import type { KeptExport, Store } from "./store";

export interface OpenProject {
  /** The exported fonts kept so far. */
  exports(): readonly KeptExport[];
  /**
   * Keeps every source font that has no artifact yet, and answers with what
   * names the artifact of each. A source can arrive without an import: a
   * reconstruction makes the empty font its letters hang on. Asked for a
   * source the project does not hold, the answer throws: that is a fault in
   * the caller, not something a person can put right.
   */
  keepSources(): Promise<(sourceId: SourceId) => string>;
  readonly means: ApplicationMeans;
  /** Records an export that was just kept, in place of the one of that name. */
  noteExport(kept: KeptExport): void;
  readonly places: Places;
  /**
   * What a run is made with, assembled once for the open project: the clock,
   * the codec, the ids, the provider's key as it stands, the store that
   * keeps model output, the workspace, and the recorded runs served with the
   * app. A command that is given a run to replay reads from that one
   * instead.
   */
  readonly running: RunMeans;
  /** The artifact that holds a source font, once it is kept. */
  sourceArtifact(sourceId: SourceId): string | undefined;
  readonly store: Store;
  readonly workspace: Workspace;
}
