import type { ArtifactBase } from "@foundry/artifacts/registry";

/** One product Artifact as the explorer lists it. */
export interface ArtifactSummary {
  /** The registry's recognized family, or null when the type is unrecognized. */
  base: ArtifactBase | null;
  /** Files in the active Content; 0 while it has none. */
  files: number;
  id: string;
  name: string;
  /** Whether `artifacts.thumbnail` has a small stored image to show. */
  thumbnail: boolean;
  /** The persisted Artifact type (a MIME type). */
  type: string;
  updatedAt: string;
}

/** A small stored image, as a `data:` URL the grid can show directly. */
export interface ArtifactThumbnail {
  url: string;
}

/** One file an Artifact can be opened at. */
export interface ArtifactEntryOption {
  bytes: number;
  mime: string | null;
  path: string;
}

/** How an editor was found: which MIME tier matched, or none did. */
export type EditorMatch = "entry" | "family" | "none" | "type";

/** A released View that declared it opens the resolved MIME type. */
export interface EditorCandidate {
  mode: "read" | "write";
  moduleId: string;
  moduleName: string;
  view: string;
  viewTitle: string | null;
}

interface ResolvedArtifact {
  id: string;
  name: string;
  type: string;
}

/**
 * What opening an Artifact needs next. A Module Artifact opens its Module;
 * a product Artifact needs an entry file, then an editor for it.
 */
export type ArtifactResolution =
  | { kind: "module"; moduleId: string }
  | { artifact: ResolvedArtifact; kind: "empty" }
  | {
      artifact: ResolvedArtifact;
      contentId: string;
      /** Every file, by path: there is no declared primary entry to open. */
      entries: ArtifactEntryOption[];
      kind: "entries";
    }
  | {
      artifact: ResolvedArtifact;
      /** Editors for `mime` at the first tier that had any; empty when none do. */
      candidates: EditorCandidate[];
      contentId: string;
      entry: ArtifactEntryOption;
      kind: "editors";
      match: EditorMatch;
      /** The MIME type the editors were matched on. */
      mime: string;
      /** The remembered choice when several editors match. */
      preferred: EditorCandidate | null;
    };

/**
 * One selected Artifact entry opened in one editor View. `binding` is the
 * opaque host-owned editor binding the View is opened with; it pins the
 * Artifact, Content, entry, access mode and (once the Program resolves it)
 * the runtime, and confers nothing to any other app.
 */
export interface EditorOpenRequest {
  artifactId: string;
  binding: string;
  contentId: string;
  entry: string;
  mode: "read" | "write";
  moduleId: string;
  view: string;
}
