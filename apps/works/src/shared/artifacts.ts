import type { ArtifactBase } from "@foundry/artifacts/registry";

export interface ArtifactSummary {
  base: ArtifactBase | null;
  files: number;
  id: string;
  name: string;
  thumbnail: boolean;
  type: string;
  updatedAt: string;
}

export interface ArtifactThumbnail {
  url: string;
}

export interface ArtifactEntryOption {
  bytes: number;
  mime: string | null;
  path: string;
}

export type EditorMatch = "entry" | "family" | "none" | "type";

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

export type ArtifactResolution =
  | { kind: "module"; moduleId: string }
  | { artifact: ResolvedArtifact; kind: "empty" }
  | {
      artifact: ResolvedArtifact;
      contentId: string;
      entries: ArtifactEntryOption[];
      kind: "entries";
    }
  | {
      artifact: ResolvedArtifact;
      candidates: EditorCandidate[];
      contentId: string;
      entry: ArtifactEntryOption;
      kind: "editors";
      match: EditorMatch;
      mime: string;
      preferred: EditorCandidate | null;
    };

export interface EditorOpenRequest {
  artifactId: string;
  binding: string;
  contentId: string;
  entry: string;
  mode: "read" | "write";
  moduleId: string;
  release: string;
  view: string;
}
