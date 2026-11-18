import type { SemanticsDeclaredDependencyKind } from "./semantics-types";

export const COLLECTION_SCHEMA_VERSION = 1;

export type WorkspaceId = string;

export type QualifiedId = `${WorkspaceId}:${string}`;

export interface CollectionWorkspace {
  dataset: string;
  generatedAt: string;
  id: WorkspaceId;
  label: string;
  packages: QualifiedId[];
}

export interface Crossing {
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  range: string;
  to: QualifiedId;
}

export interface AmbiguousDependency {
  candidates: QualifiedId[];
  from: QualifiedId;
  kind: SemanticsDeclaredDependencyKind;
  name: string;
  range: string;
  skippedIn?: WorkspaceId[];
}

export interface CollectionManifest {
  ambiguous: AmbiguousDependency[];
  crossings: Crossing[];
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  workspaces: CollectionWorkspace[];
}
