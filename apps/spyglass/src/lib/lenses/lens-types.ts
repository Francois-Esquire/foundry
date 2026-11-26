import type { DatasetReader } from "../dataset";
import { lensFile } from "../dataset-layout";
import type { DomainDeclaration } from "../domain-declaration";
import type { Rule } from "../rule-declaration";
import type { DatasetManifest } from "../semantics-types";
import type { Domains } from "./domains-types";
import { DOMAINS_SCHEMA_VERSION } from "./domains-types";
import type { FileRoles } from "./file-roles-types";
import { FILE_ROLES_SCHEMA_VERSION } from "./file-roles-types";
import type { FrequentChange } from "./frequent-change-types";
import { FREQUENT_CHANGE_SCHEMA_VERSION } from "./frequent-change-types";
import type { ImportTraffic } from "./import-traffic-types";
import { IMPORT_TRAFFIC_SCHEMA_VERSION } from "./import-traffic-types";
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
import type { Rules } from "./rules-types";
import { RULES_SCHEMA_VERSION } from "./rules-types";

export interface LensOutputs {
  domains: Domains;
  "file-roles": FileRoles;
  "frequent-change": FrequentChange;
  "import-traffic": ImportTraffic;
  nesting: Nesting;
  "package-sizes": PackageSizes;
  placement: Placements;
  proximity: Proximity;
  "responsibility-groups": ResponsibilityGroups;
  rules: Rules;
}

export type LensId = keyof LensOutputs;

export const LENS_SCHEMA_VERSIONS: Record<LensId, number> = {
  domains: DOMAINS_SCHEMA_VERSION,
  "file-roles": FILE_ROLES_SCHEMA_VERSION,
  "frequent-change": FREQUENT_CHANGE_SCHEMA_VERSION,
  "import-traffic": IMPORT_TRAFFIC_SCHEMA_VERSION,
  nesting: NESTING_SCHEMA_VERSION,
  "package-sizes": PACKAGE_SIZES_SCHEMA_VERSION,
  placement: PLACEMENT_SCHEMA_VERSION,
  proximity: PROXIMITY_SCHEMA_VERSION,
  "responsibility-groups": RESPONSIBILITY_GROUPS_SCHEMA_VERSION,
  rules: RULES_SCHEMA_VERSION,
};

export const LENS_IDS: readonly LensId[] = (
  Object.keys(LENS_SCHEMA_VERSIONS) as LensId[]
).sort((a, b) => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
});

export interface LensSettings {
  domains: readonly DomainDeclaration[];

  rules: readonly Rule[];
}

interface LensPackage {
  id: string;

  internals: boolean;

  path: string;
  status: DatasetManifest["packages"][number]["status"];
}

export type LensReader = Omit<
  DatasetReader,
  "analysis" | "history" | "manifest"
> & {
  packages(): readonly LensPackage[];
};

export interface Lens<
  I extends LensId,
  Source,
  K extends keyof LensSettings = never,
> {
  consumes?: readonly LensId[];

  derive(source: Source, settings: Pick<LensSettings, K>): LensOutputs[I];
  id: I;

  read(reader: LensReader, settings: Pick<LensSettings, K>): Promise<Source>;

  schemaVersion: number;

  settings: readonly K[];
}

interface DatasetManifestLens {
  file: string;
  schemaVersion: number;
}

export type DatasetManifestLenses = { [I in LensId]?: DatasetManifestLens };

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
