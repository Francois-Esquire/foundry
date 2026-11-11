/**
 * The project file: everything in a project but file bytes, as one JSON
 * document. Source fonts and photographs are named by the artifact that
 * holds their bytes. Reading a file gives back the project that was written,
 * with the same revisions, candidates, pinned instances, ids and times:
 * nothing is replayed.
 */
import type { Verdict } from "~/generation/evaluation/evaluation";
import type { Revision } from "~/typeface/changes";
import type { Face, FaceId, SourceId } from "~/typeface/face";
import type {
  Candidate,
  SourceFont,
  TypefaceProject,
} from "~/typeface/project";
import { Refusal } from "./refusal";

/** An imported photograph: evidence a reconstruction can read. */
interface Photograph {
  readonly artifactId: string;
  readonly fileName: string;
  /** The SHA-256 digest of the file, which is its evidence id. */
  readonly id: string;
}

/**
 * A run whose glyphs go into a face together or not at all, waiting to be
 * accepted. Its change set is kept with the run's model output.
 */
export interface WaitingRun {
  readonly faceId: FaceId;
  /** How many glyphs the run adds. */
  readonly glyphs: number;
  /** The artifact that holds the run's model output and its change set. */
  readonly modelOutput: string;
  readonly runId: string;
  /** The script the run extends the face into, as its plan names it. */
  readonly script: string;
}

/** What a saved project holds beside the Typeface Project itself. */
export interface Kept {
  readonly photographs: readonly Photograph[];
  /** The verdict each generated candidate was given, by candidate id. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
  readonly waitingRuns: readonly WaitingRun[];
}

export const NOTHING_KEPT: Kept = {
  photographs: [],
  verdicts: {},
  waitingRuns: [],
};

const FORMAT = 1;

type SavedSource = Omit<SourceFont, "bytes"> & { readonly artifactId: string };

interface ProjectFile extends Kept {
  readonly activeFaceId?: FaceId;
  readonly candidates: readonly Candidate[];
  readonly faces: readonly Face[];
  readonly format: typeof FORMAT;
  readonly head: number;
  readonly name: string;
  readonly revisions: readonly Revision[];
  readonly sources: readonly SavedSource[];
}

export interface OpenedProject {
  readonly activeFaceId: FaceId | undefined;
  readonly kept: Kept;
  readonly project: TypefaceProject;
  /** The artifact that holds each source font's bytes. */
  readonly sourceArtifacts: ReadonlyMap<SourceId, string>;
}

/** The project file's text. `artifactOf` names the artifact of a source font. */
export const writeProjectFile = (
  { activeFaceId, kept, project }: Omit<OpenedProject, "sourceArtifacts">,
  artifactOf: (sourceId: SourceId) => string
): string => {
  const file: ProjectFile = {
    activeFaceId,
    candidates: project.candidates,
    faces: project.faces,
    format: FORMAT,
    head: project.head,
    name: project.name,
    photographs: kept.photographs,
    revisions: project.revisions,
    sources: project.sources.map(({ bytes: _bytes, ...source }) => ({
      ...source,
      artifactId: artifactOf(source.id),
    })),
    verdicts: kept.verdicts,
    waitingRuns: kept.waitingRuns,
  };
  return JSON.stringify(file);
};

const isProjectFile = (value: unknown): value is ProjectFile =>
  typeof value === "object" &&
  value !== null &&
  "format" in value &&
  value.format === FORMAT &&
  ["candidates", "faces", "revisions", "sources"].every(
    (list) =>
      list in value &&
      Array.isArray((value as Readonly<Record<string, unknown>>)[list])
  );

/** Reads a project file. `bytesOf` reads a source font's bytes from its artifact. */
export const readProjectFile = async (
  text: string,
  bytesOf: (artifactId: string) => Promise<Uint8Array>
): Promise<OpenedProject> => {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    file = undefined;
  }
  if (!isProjectFile(file)) {
    throw new Refusal(
      "The saved project cannot be read: its file is not a project this version of the app wrote."
    );
  }
  const sources: SourceFont[] = [];
  const sourceArtifacts = new Map<SourceId, string>();
  for (const { artifactId, ...source } of file.sources) {
    sources.push({ ...source, bytes: await bytesOf(artifactId) });
    sourceArtifacts.set(source.id, artifactId);
  }
  return {
    activeFaceId: file.activeFaceId,
    kept: {
      photographs: file.photographs,
      verdicts: file.verdicts,
      waitingRuns: file.waitingRuns,
    },
    project: {
      candidates: file.candidates,
      faces: file.faces,
      head: file.head,
      name: file.name,
      revisions: file.revisions,
      sources,
    },
    sourceArtifacts,
  };
};
