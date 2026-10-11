import { basename, dirname } from "node:path";
import { byCodeUnit } from "@foundry/lib/ordering";
import type {
  AmbiguousDependency,
  CollectionManifest,
  CollectionWorkspace,
  Crossing,
  QualifiedId,
  WorkspaceId,
} from "./collection-types";
import { COLLECTION_SCHEMA_VERSION } from "./collection-types";
import { collectionDataset } from "./dataset-layout";
import type {
  DatasetManifest,
  SemanticsDeclaredDependencyKind,
} from "./semantics-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

/** One workspace of a collection and its saved dataset's manifest. */
export interface CollectionManifestWorkspace {
  /** The workspace id. */
  id: string;
  manifest: Pick<DatasetManifest, "generatedAt" | "packages" | "workspace"> & {
    discovery: Pick<DatasetManifest["discovery"], "unitsSkipped">;
  };
  /** The workspace root, resolved; only its last two names are read, for labels. */
  root: string;
}

/** One declared dependency of a package, with the package name it resolves to. */
interface Declared {
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  name: string;
  range: string;
  workspace: string;
}

const NPM_ALIAS = "npm:";
const WORKSPACE_PROTOCOL = "workspace:";

/**
 * The collection manifest of `workspaces`, ordered by resolved root (as
 * `resolveCollection` orders them). Pure: the same manifests give the same
 * manifest, with no time of its own. The range is recorded as written, not
 * checked against the package found. A declared dependency, by the name it
 * resolves to through an `npm:` alias:
 * - stays inside its workspace when its range uses the `workspace:`
 *   protocol, or when its own workspace holds the name, as a package it
 *   analyzed or as a unit it skipped;
 * - crosses when exactly one other workspace holds the name and holds it as
 *   an analyzed package;
 * - is external, as when no workspace holds the name, when exactly one other
 *   workspace holds it only as a skipped unit, since a crossing ends at a
 *   listed package;
 * - is ambiguous, with no crossing, when two or more other workspaces hold
 *   it: `candidates` are the analyzed packages of that name, and `skippedIn`
 *   the workspaces that hold it only as a skipped unit.
 */
export function collectionManifest(
  workspaces: readonly CollectionManifestWorkspace[]
): CollectionManifest {
  const ordered = [...workspaces].sort(byRoot);
  const { analyzed, held } = packageHolders(ordered);
  const crossings: Crossing[] = [];
  const ambiguous: AmbiguousDependency[] = [];
  for (const { from, kind, name, range, workspace } of declared(ordered)) {
    const holders = held.get(name) ?? [];
    if (range.startsWith(WORKSPACE_PROTOCOL) || holders.includes(workspace)) {
      continue;
    }
    const listed = analyzed.get(name) ?? [];
    const [only, ...more] = holders;
    if (only !== undefined && more.length === 0 && listed.includes(only)) {
      crossings.push({ from, kind, range, to: qualifiedId(only, name) });
    } else if (more.length > 0) {
      const skippedIn = holders.filter((holder) => !listed.includes(holder));
      ambiguous.push({
        candidates: listed.map((holder) => qualifiedId(holder, name)),
        from,
        kind,
        name,
        range,
        ...(skippedIn.length > 0 && { skippedIn }),
      });
    }
  }
  return {
    ambiguous: ambiguous.sort(
      (a, b) => byFrom(a, b) || byName(a, b) || byKind(a, b) || byRange(a, b)
    ),
    crossings: crossings.sort(
      (a, b) => byFrom(a, b) || byTo(a, b) || byKind(a, b) || byRange(a, b)
    ),
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    workspaces: collectionWorkspaces(ordered),
  };
}

// Each by code unit, so the order is the same in every locale.
const byString = byCodeUnit((value: string) => value);
const byRoot = byCodeUnit(
  (workspace: CollectionManifestWorkspace) => workspace.root
);
const byFrom = byCodeUnit((entry: { from: string }) => entry.from);
const byKind = byCodeUnit((entry: { kind: string }) => entry.kind);
const byName = byCodeUnit((entry: AmbiguousDependency) => entry.name);
const byRange = byCodeUnit((entry: { range: string }) => entry.range);
const byTo = byCodeUnit((entry: Crossing) => entry.to);

/** `<workspace id>:<package>`; a workspace id is hex, so the first colon divides it. */
export function qualifiedId(workspace: WorkspaceId, id: string): QualifiedId {
  return `${workspace}:${id}`;
}

/**
 * For each package name, the workspaces that hold it, in the collection's
 * order: `analyzed`, those whose manifest lists a package of that name, and
 * `held`, those as well as those whose scan skipped a unit of that name, such
 * as a JavaScript-only package, so that a dependency on it stays inside its
 * workspace.
 */
function packageHolders(workspaces: readonly CollectionManifestWorkspace[]): {
  analyzed: Map<string, WorkspaceId[]>;
  held: Map<string, WorkspaceId[]>;
} {
  const analyzed = new Map<string, WorkspaceId[]>();
  const held = new Map<string, WorkspaceId[]>();
  for (const { id, manifest } of workspaces) {
    const listed = manifest.packages.map((pkg) => pkg.id);
    const skipped = manifest.discovery.unitsSkipped.flatMap(
      (unit) => unit.name ?? []
    );
    addHolder(analyzed, listed, id);
    addHolder(held, [...listed, ...skipped], id);
  }
  return { analyzed, held };
}

function addHolder(
  holders: Map<string, WorkspaceId[]>,
  names: readonly string[],
  id: WorkspaceId
): void {
  for (const name of names) {
    const found = holders.get(name) ?? [];
    holders.set(name, found.includes(id) ? found : [...found, id]);
  }
}

/** Every declared dependency of every package in `workspaces`. */
function* declared(
  workspaces: readonly CollectionManifestWorkspace[]
): Generator<Declared> {
  for (const { id: workspace, manifest } of workspaces) {
    for (const pkg of manifest.packages) {
      const from = qualifiedId(workspace, pkg.id);
      for (const kind of SEMANTICS_DECLARED_DEPENDENCY_KINDS) {
        const ranges = Object.entries(pkg.declaredDependencies[kind] ?? {});
        for (const [written, range] of ranges) {
          const name = dependencyName(written, range);
          yield { from, kind, name, range, workspace };
        }
      }
    }
  }
}

/**
 * The package a dependency names: the name it is written under, or the
 * package an `npm:` alias resolves to (`npm:@k/db@^1.0.0` is `@k/db`, and
 * `npm:lodash` is `lodash`).
 */
function dependencyName(written: string, range: string): string {
  if (!range.startsWith(NPM_ALIAS)) {
    return written;
  }
  const target = range.slice(NPM_ALIAS.length);
  // A scope's own `@` comes first; the version's `@` follows the name.
  const version = target.indexOf("@", target.startsWith("@") ? 1 : 0);
  return version === -1 ? target : target.slice(0, version);
}

/**
 * Each workspace's entry. Its label is its `package.json` name, else its
 * directory's name; where two workspaces would share a label, each of them
 * is `parent/name` from its root, and where two would share that too, each
 * adds the first six digits of its id. Labels are for people: two roots
 * whose ids also start alike could still share one, while ids never do.
 */
function collectionWorkspaces(
  workspaces: readonly CollectionManifestWorkspace[]
): CollectionWorkspace[] {
  const named = distinguish(
    workspaces.map(
      ({ manifest, root }) => manifest.workspace.name ?? basename(root)
    ),
    (index) => {
      const root = workspaces[index]?.root ?? "";
      return `${basename(dirname(root))}/${basename(root)}`;
    }
  );
  const labels = distinguish(
    named,
    (index) =>
      `${named[index]} (${workspaces[index]?.id.slice(0, ID_PREFIX_LENGTH)})`
  );
  return workspaces.map(({ id, manifest }, index) => ({
    dataset: collectionDataset(id),
    generatedAt: manifest.generatedAt,
    id,
    label: labels[index] ?? id,
    packages: manifest.packages
      .map((pkg) => qualifiedId(id, pkg.id))
      .sort(byString),
  }));
}

/** The first digits of a workspace id that tell two equal labels apart. */
const ID_PREFIX_LENGTH = 6;

/** `labels`, with each label two or more share replaced by `instead(index)`. */
function distinguish(
  labels: readonly string[],
  instead: (index: number) => string
): string[] {
  return labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label) ? label : instead(index)
  );
}
