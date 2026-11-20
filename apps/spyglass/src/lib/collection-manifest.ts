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

export interface CollectionManifestWorkspace {
  id: string;
  manifest: Pick<DatasetManifest, "generatedAt" | "packages" | "workspace"> & {
    discovery: Pick<DatasetManifest["discovery"], "unitsSkipped">;
  };
  root: string;
}

interface Declared {
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  name: string;
  range: string;
  workspace: string;
}

const NPM_ALIAS = "npm:";
const WORKSPACE_PROTOCOL = "workspace:";

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

const byString = byCodeUnit((value: string) => value);
const byRoot = byCodeUnit(
  (workspace: CollectionManifestWorkspace) => workspace.root
);
const byFrom = byCodeUnit((entry: { from: string }) => entry.from);
const byKind = byCodeUnit((entry: { kind: string }) => entry.kind);
const byName = byCodeUnit((entry: AmbiguousDependency) => entry.name);
const byRange = byCodeUnit((entry: { range: string }) => entry.range);
const byTo = byCodeUnit((entry: Crossing) => entry.to);

export function qualifiedId(workspace: WorkspaceId, id: string): QualifiedId {
  return `${workspace}:${id}`;
}

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

function dependencyName(written: string, range: string): string {
  if (!range.startsWith(NPM_ALIAS)) {
    return written;
  }
  const target = range.slice(NPM_ALIAS.length);
  const version = target.indexOf("@", target.startsWith("@") ? 1 : 0);
  return version === -1 ? target : target.slice(0, version);
}

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

const ID_PREFIX_LENGTH = 6;

function distinguish(
  labels: readonly string[],
  instead: (index: number) => string
): string[] {
  return labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label) ? label : instead(index)
  );
}
