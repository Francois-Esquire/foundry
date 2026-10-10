import type { DatasetReader } from "../dataset";
import { lensFile } from "../dataset-layout";
import type { DomainDeclaration } from "../domain-declaration";
import type { DatasetManifest } from "../semantics-types";
import type { Domains } from "./domains-types";
import { DOMAINS_SCHEMA_VERSION } from "./domains-types";
import type { FileRoles } from "./file-roles-types";
import { FILE_ROLES_SCHEMA_VERSION } from "./file-roles-types";
import type { FrequentChange } from "./frequent-change-types";
import { FREQUENT_CHANGE_SCHEMA_VERSION } from "./frequent-change-types";
import type { Nesting } from "./nesting-types";
import { NESTING_SCHEMA_VERSION } from "./nesting-types";
import type { PackageSizes } from "./package-sizes-types";
import { PACKAGE_SIZES_SCHEMA_VERSION } from "./package-sizes-types";
import type { Placements } from "./placement-types";
import { PLACEMENT_SCHEMA_VERSION } from "./placement-types";
import type { Proximity } from "./proximity-types";
import { PROXIMITY_SCHEMA_VERSION } from "./proximity-types";
import type { ResponsibilityGroups } from "./responsibility-groups-types";
import { RESPONSIBILITY_GROUPS_SCHEMA_VERSION } from "./responsibility-groups-types";

// The lens contract (docs/atlas/_lenses.md). A leaf the viewer bundles: the
// dataset reader imports the schema versions from here.

/** Every lens's saved output, by the lens's id. */
export interface LensOutputs {
  domains: Domains;
  "file-roles": FileRoles;
  "frequent-change": FrequentChange;
  nesting: Nesting;
  "package-sizes": PackageSizes;
  placement: Placements;
  proximity: Proximity;
  "responsibility-groups": ResponsibilityGroups;
}

/** A lens's id: stable, it names the lens's stage and its file in the dataset. */
export type LensId = keyof LensOutputs;

/** Each lens's schema version, which the reader checks against the manifest's. */
export const LENS_SCHEMA_VERSIONS: Record<LensId, number> = {
  domains: DOMAINS_SCHEMA_VERSION,
  "file-roles": FILE_ROLES_SCHEMA_VERSION,
  "frequent-change": FREQUENT_CHANGE_SCHEMA_VERSION,
  nesting: NESTING_SCHEMA_VERSION,
  "package-sizes": PACKAGE_SIZES_SCHEMA_VERSION,
  placement: PLACEMENT_SCHEMA_VERSION,
  proximity: PROXIMITY_SCHEMA_VERSION,
  "responsibility-groups": RESPONSIBILITY_GROUPS_SCHEMA_VERSION,
};

/** What a lens may read beyond the dataset: the workspace's own settings. */
export interface LensSettings {
  domains: readonly DomainDeclaration[];
}

/** A package as the manifest lists it, by its deterministic fields only. */
interface LensPackage {
  id: string;
  /** Whether the dataset holds the package's internals; a lens that needs them reports the package missing otherwise. */
  internals: boolean;
  /** Workspace-relative path of the package root, as the manifest records it; `""` or `"."` for a package at the workspace root. */
  path: string;
  status: DatasetManifest["packages"][number]["status"];
}

/**
 * The dataset as a lens reads it: the reader without `history()`, which is
 * written after the dataset is published, and without `manifest()`, whose
 * generation fields differ between the draft a lens runs against and the
 * manifest finally published. `packages()` stands in for the manifest's
 * package list. Within one scan, every file is parsed once and shared by
 * every lens, so a lens never changes what it reads; package reports are
 * the exception, read afresh for each request, so a lens that reads them
 * reads them one at a time and keeps only the fields it needs.
 */
export type LensReader = Omit<DatasetReader, "history" | "manifest"> & {
  packages(): readonly LensPackage[];
};

export interface Lens<
  I extends LensId,
  Source,
  K extends keyof LensSettings = never,
> {
  /** The lenses whose output this one reads; they run first, and it may read no others. */
  consumes?: readonly LensId[];
  /** Pure: the same source and settings give the same output. */
  derive(source: Source, settings: Pick<LensSettings, K>): LensOutputs[I];
  id: I;
  /**
   * Picks every dataset field the lens reads, as the codex's
   * `readCodexSource` does, given the same settings `derive` gets, so that
   * a lens can leave unread what its settings do not need.
   */
  read(reader: LensReader, settings: Pick<LensSettings, K>): Promise<Source>;
  /** Bumped when Output's shape or meaning changes; the lens stage's schema version. */
  schemaVersion: number;
  /** The settings the lens reads; a lens that names none sees none. */
  settings: readonly K[];
}

/** A lens's entry in the manifest. */
interface DatasetManifestLens {
  file: string;
  schemaVersion: number;
}

/** The manifest's `lenses`: every lens's entry, by id. A dataset saved before a lens existed has none for it. */
export type DatasetManifestLenses = { [I in LensId]?: DatasetManifestLens };

/** Each lens's manifest entry, known before any lens runs. */
export function lensEntries(): DatasetManifestLenses {
  const entries: DatasetManifestLenses = {};
  for (const id of Object.keys(LENS_SCHEMA_VERSIONS) as LensId[]) {
    entries[id] = {
      file: lensFile(id),
      schemaVersion: LENS_SCHEMA_VERSIONS[id],
    };
  }
  return entries;
}
