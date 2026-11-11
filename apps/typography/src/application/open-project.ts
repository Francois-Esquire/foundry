/**
 * The open project as a command sees it: the workspace, the places' use
 * cases, the store, and what the project holds beside the Typeface Project.
 */
import type { SourceId } from "~/typeface/face";
import type { Workspace } from "~/workspace/workspace";
import type { ApplicationMeans } from "./means";
import type { Places } from "./places";
import type { Kept } from "./project-file";
import type { KeptExport, Store } from "./store";

export interface OpenProject {
  /** The exported fonts kept so far. */
  exports(): readonly KeptExport[];
  /** Replaces part of what the project holds beside the Typeface Project. */
  keep(patch: Partial<Kept>): void;
  /**
   * Keeps every source font that has no artifact yet, and answers with the
   * artifact of each. A source can arrive without an import: a
   * reconstruction makes the empty font its letters hang on.
   */
  keepSources(): Promise<ReadonlyMap<SourceId, string>>;
  kept(): Kept;
  readonly means: ApplicationMeans;
  /** Records an export that was just kept, in place of the one of that name. */
  noteExport(kept: KeptExport): void;
  readonly places: Places;
  /** The artifact that holds a source font, once it is kept. */
  sourceArtifact(sourceId: SourceId): string | undefined;
  readonly store: Store;
  readonly workspace: Workspace;
}
