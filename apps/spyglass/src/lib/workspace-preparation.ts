import type { Project } from "ts-morph";
import type { SourceOwner } from "./boundary-model";
import { ownerResult, ROOT_OWNER } from "./boundary-model";

// Steps of workspace-derivation preparation that read nothing themselves:
// which owners to table, with their deferred errors, and which destination
// names fold planning must answer. Native preparation (`workspace-derive.ts`)
// and file-map preparation (`file-map-preparation.ts`) both call them.

/**
 * Owners tabled at preparation, keyed by absolute path, and the error the
 * owner lookup threw for each path it could not answer (a manifest that
 * does not parse, say). Analysis rethrows an error only when it asks for
 * that path, as the native lookup threw only when asked.
 */
export interface OwnerTable {
  readonly errors: Map<string, unknown>;
  readonly owners: Map<string, string>;
}

export function emptyOwnerTable(): OwnerTable {
  return { errors: new Map(), owners: new Map() };
}

/** Table `filePath`'s owner, or the error its lookup throws, once. */
export function tableOwner(
  table: OwnerTable,
  filePath: string,
  ownerOf: SourceOwner
): void {
  if (table.owners.has(filePath) || table.errors.has(filePath)) {
    return;
  }
  const result = ownerResult(ownerOf, filePath);
  if ("ownerError" in result) {
    table.errors.set(filePath, result.ownerError);
  } else {
    table.owners.set(filePath, result.owner);
  }
}

/**
 * Every name analysis can give a package's primary consumer, which a fold
 * plan resolves as its destination: the owners tabled and `<root>`. Full
 * native preparation reads a destination for each.
 */
export function foldDestinationCandidates(
  owners: ReadonlyMap<string, string>
): Set<string> {
  const names = new Set<string>(owners.values());
  names.add(ROOT_OWNER);
  return names;
}

/**
 * Owns every file of the shared program outside `node_modules`, the files
 * the reference index and the concept sweeps visit. That set includes files
 * the program reaches only through imports (an imported `*.config.ts`, a
 * fixture, a declaration file), and a relative or `paths` import is not
 * realpathed (only `node_modules` resolutions are), so it may be spelled
 * through an in-root symbolic link, or lie in a sibling sharing the root's
 * prefix. The manifest walk (`ownerOf`) answers all of them. `node_modules`
 * paths are skipped, as every caller skips them before asking. A lookup
 * that throws is tabled as an error, raised only if analysis asks.
 */
export function tableProgramOwners(
  project: Project,
  table: OwnerTable,
  ownerOf: SourceOwner
): void {
  for (const file of project.getProgram().compilerObject.getSourceFiles()) {
    if (!file.fileName.includes("/node_modules/")) {
      tableOwner(table, file.fileName, ownerOf);
    }
  }
}
