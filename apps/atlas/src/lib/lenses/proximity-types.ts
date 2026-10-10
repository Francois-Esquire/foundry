import type { StaticPathRelation } from "../types";
import type { WorkspaceCouplingPair } from "../workspace-types";

/** Bumped when `Proximity` changes shape or meaning. */
export const PROXIMITY_SCHEMA_VERSION = 1;

/** Responsibilities with files in one folder that something relates, and those files. */
interface ProximityGroup {
  /**
   * The group's files that are also in `apart.files`, sorted; empty when
   * none are. A group can consist only of files that are apart, so a reader
   * counting signals counts such a file once, not as both a close and an
   * apart observation.
   */
  apart: string[];
  /** Workspace-relative paths of the group's files directly in the folder, sorted. */
  files: string[];
  /** Responsibility ids, sorted. */
  responsibilities: string[];
}

/**
 * A folder that sits files close without relating them: its files directly
 * in it fall into two or more groups of responsibilities, where a group is
 * the folder's responsibilities joined by a relationship (an import between
 * them, either way) or by a co-change between their source files, directly
 * or through other responsibilities in the same folder. A responsibility
 * that both relate to but that has no file in the folder does not join
 * them. Nothing relates one group to another.
 */
export interface ProximityFolder {
  /** The folder, as the `nesting` lens names it. */
  folder: string;
  /** Two or more, by their first responsibility id. */
  groups: ProximityGroup[];
  /** By manifest id. */
  package: string;
  /** Source files directly in the folder that no responsibility holds, left out of every group. */
  unresolved: number;
}

/**
 * A file related to files that sit elsewhere: its responsibility's dominant
 * folder, the one holding most of its files, is not the file's own, as the
 * responsibilities' `pathAgreesWithRegion` says.
 */
export interface ProximityFile {
  /** Folder steps from the file's folder to the responsibility's (`directoryDistance`). */
  distance: number;
  /** Workspace-relative path. */
  file: string;
  folder: string;
  /** By manifest id. */
  package: string;
  responsibility: string;
  /** The responsibility's dominant folder, workspace-relative. */
  responsibilityFolder: string;
}

/** Two source files that change together, as the workspace report keeps the pair, from different folders. */
export interface ProximityCoChange {
  coChangeCommits: number;
  /** Folder steps between the two files' folders. */
  distance: number;
  /** The workspace report's pair id. */
  id: string;
  jaccard: number;
  left: string;
  right: string;
  scope: WorkspaceCouplingPair["scope"];
  /** Whether the import graph reaches one file from the other, as the pair records it. */
  staticPath: StaticPathRelation;
}

/** One package with internals, by manifest id. */
interface ProximityPackage {
  id: string;
  /** Its source files that no responsibility holds, left out of relatedness. */
  unresolved: number;
}

/**
 * The `proximity` lens: what sits close without being related (`close`),
 * and what is related without sitting close (`apart`). Close is one folder;
 * related is one responsibility, a relationship between responsibilities,
 * or a co-change. `close` and `apart.files` need internals, so they cover
 * the packages in `packages`, and `missing` lists the complete packages
 * without internals; `apart.coChanges` comes from the workspace report and
 * covers every package. Sorted by folder, file, and pair id.
 */
export interface Proximity {
  apart: { coChanges: ProximityCoChange[]; files: ProximityFile[] };
  close: ProximityFolder[];
  missing: string[];
  packages: ProximityPackage[];
}
