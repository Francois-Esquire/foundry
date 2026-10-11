// The collection manifest's shape: what `serve` answers at
// `data/collection-manifest.json` and `atlas export` writes there, for the
// viewer and for anything else that reads several workspaces' datasets
// together. Browser-safe: types and one constant.

import type { SemanticsDeclaredDependencyKind } from "./semantics-types";

/**
 * The collection manifest's schema version, the promise a reader holds it
 * to: independent of each workspace's `DATASET_SCHEMA_VERSION`.
 */
export const COLLECTION_SCHEMA_VERSION = 1;

/** A workspace id: the 12 hex digits that name its state directory. */
export type WorkspaceId = string;

/** A package's id in a collection: its workspace's id, a colon, and its package name. */
export type QualifiedId = `${WorkspaceId}:${string}`;

/** One workspace of a collection, as the collection manifest lists it. */
export interface CollectionWorkspace {
  /** Where its dataset is, relative to the collection manifest: `<id>/`. */
  dataset: string;
  /** Its dataset manifest's `generatedAt`, when the manifest was derived. */
  generatedAt: string;
  /** Qualifies its packages. */
  id: WorkspaceId;
  /** What people call it: its `package.json` name, else its directory's name, else `parent/name` where two labels in the collection are equal. */
  label: string;
  /** Every package its dataset lists, qualified, sorted. */
  packages: QualifiedId[];
}

/** A declared dependency of a package in one workspace on a package in another. */
export interface Crossing {
  /** The declaring package. */
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  /** The range as written, an `npm:` alias included; not checked against the package found. */
  range: string;
  /** The package it names, analyzed, in another workspace of the collection, so listed in that workspace's `packages`. */
  to: QualifiedId;
}

/** A declared dependency whose name two or more other workspaces hold; it makes no crossing. */
export interface AmbiguousDependency {
  /** Every analyzed package of that name in another workspace, in the collection's order; each is listed in its workspace's `packages`. */
  candidates: QualifiedId[];
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  /** The package name it names, after an `npm:` alias is resolved. */
  name: string;
  range: string;
  /** The other workspaces that hold the name only as a unit their scan skipped, in the collection's order; absent when none does. */
  skippedIn?: WorkspaceId[];
}

/**
 * Several workspaces read together: each workspace, where its dataset is,
 * and the crossings between them. Derived from the workspaces' saved
 * manifests, never saved on its own.
 */
export interface CollectionManifest {
  /** Dependencies that name a package two or more other workspaces hold, sorted by `from`, `name`, and `kind`. */
  ambiguous: AmbiguousDependency[];
  /** Sorted by `from`, `to`, and `kind`. */
  crossings: Crossing[];
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  /** In the collection's order: by resolved root. */
  workspaces: CollectionWorkspace[];
}
