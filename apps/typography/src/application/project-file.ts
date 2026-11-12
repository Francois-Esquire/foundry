/**
 * The project file: everything in a project but file bytes, as one JSON
 * document. Source fonts and photographs are named by the artifact that
 * holds their bytes. Reading a file gives back the project that was written,
 * with the same revisions, candidates, runs, pinned instances, ids and
 * times: nothing is replayed.
 *
 * Format 2 is the one written. Format 1 kept three things beside the
 * project that the project now holds itself, and is read by moving each to
 * its owner: a verdict onto its candidate, and a waiting run into the
 * project's runs with the changes its model-output artifact held.
 */
import { Refusal } from "~/lib/refusal";
import type { Change, Revision } from "~/typeface/changes";
import type { Face, FaceId, SourceId } from "~/typeface/face";
import {
  type Candidate,
  type CandidateStatus,
  candidateStatuses,
  type HeldRun,
  type Photograph,
  type SourceFont,
  type TypefaceProject,
  type Verdict,
} from "~/typeface/project";
import { photographArtifact } from "./store";

type SavedSource = Omit<SourceFont, "bytes"> & { readonly artifactId: string };

/** A photograph with the artifact its file is in, as the file has always spelled it. */
type SavedPhotograph = Photograph & { readonly artifactId: string };

/** A candidate as the file has always spelled it: with its standing written out. */
type SavedCandidate = Omit<Candidate, "rejected"> & {
  readonly status: CandidateStatus;
};

/** What every format of the file holds, spelled the same way. */
interface SavedProject {
  readonly activeFaceId?: FaceId;
  readonly candidates: readonly SavedCandidate[];
  readonly faces: readonly Face[];
  readonly head: number;
  readonly name: string;
  readonly photographs: readonly SavedPhotograph[];
  readonly revisions: readonly Revision[];
  readonly sources: readonly SavedSource[];
}

interface ProjectFile extends SavedProject {
  readonly format: 2;
  readonly runs: readonly HeldRun[];
}

/** The file as the app wrote it before verdicts and waiting runs had one owner. */
interface Format1File extends SavedProject {
  readonly format: 1;
  /** The verdict each generated candidate was given, by candidate id. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
  /** Each waiting run, without its changes: those were in `modelOutput`. */
  readonly waitingRuns: readonly Omit<HeldRun, "changes">[];
}

export interface OpenedProject {
  readonly activeFaceId: FaceId | undefined;
  readonly project: TypefaceProject;
  /** The artifact that holds each source font's bytes. */
  readonly sourceArtifacts: ReadonlyMap<SourceId, string>;
}

/** The project file's text. `artifactOf` names the artifact of a source font. */
export const writeProjectFile = (
  { activeFaceId, project }: Omit<OpenedProject, "sourceArtifacts">,
  artifactOf: (sourceId: SourceId) => string
): string => {
  const statuses = candidateStatuses(project);
  const file: ProjectFile = {
    activeFaceId,
    candidates: project.candidates.map(
      ({ rejected: _rejected, ...candidate }) => ({
        ...candidate,
        status: statuses.get(candidate.id) ?? "proposed",
      })
    ),
    faces: project.faces,
    format: 2,
    head: project.head,
    name: project.name,
    photographs: project.photographs.map(({ fileName, id }) => ({
      artifactId: photographArtifact(id),
      fileName,
      id,
    })),
    revisions: project.revisions,
    runs: project.runs,
    sources: project.sources.map(({ bytes: _bytes, ...source }) => ({
      ...source,
      artifactId: artifactOf(source.id),
    })),
  };
  return JSON.stringify(file);
};

type Fields = Readonly<Record<string, unknown>>;

const hasLists = (value: Fields, lists: readonly string[]) =>
  lists.every((list) => Array.isArray(value[list]));

const SHARED_LISTS = ["candidates", "faces", "photographs", "revisions"];

const isFormat2 = (value: Fields): value is Fields & ProjectFile =>
  value.format === 2 && hasLists(value, [...SHARED_LISTS, "runs", "sources"]);

const isFormat1 = (value: Fields): value is Fields & Format1File =>
  value.format === 1 &&
  hasLists(value, [...SHARED_LISTS, "sources", "waitingRuns"]) &&
  typeof value.verdicts === "object" &&
  value.verdicts !== null;

/**
 * A format-1 file as format 2 spells the same project. `changesOf` reads the
 * change set format 1 kept in a waiting run's model-output artifact. A run
 * whose changes cannot be read stops the project opening, with the run and
 * the artifact named: opened without it, the run would be lost for good at
 * the next save.
 */
const fromFormat1 = async (
  { verdicts, waitingRuns, ...file }: Format1File,
  changesOf: (artifactId: string) => Promise<readonly Change[]>
): Promise<ProjectFile> => {
  const runs: HeldRun[] = [];
  for (const run of waitingRuns) {
    try {
      runs.push({ ...run, changes: await changesOf(run.modelOutput) });
    } catch (error) {
      if (!(error instanceof Refusal)) {
        throw error;
      }
      throw new Refusal(
        `The saved project cannot be opened: the changes of its waiting run ${run.runId} could not be read from the artifact ${run.modelOutput}. ${error.message} The project was left as it is.`,
        { cause: error }
      );
    }
  }
  return {
    ...file,
    candidates: file.candidates.map((candidate) => {
      const verdict = verdicts[candidate.id];
      return verdict === undefined ? candidate : { ...candidate, verdict };
    }),
    format: 2,
    runs,
  };
};

/** What reading a project file reads from the artifacts beside it. */
export interface FileReads {
  /** The change set a format-1 file kept in a waiting run's artifact. */
  readonly changesOf: (artifactId: string) => Promise<readonly Change[]>;
  /** A source font's bytes, from its artifact. */
  readonly sourceBytes: (artifactId: string) => Promise<Uint8Array>;
}

/** The file's text as a value, or nothing when it is not JSON. */
const parsed = (text: string): unknown => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return value;
};

/** The file in the format that is written now, whichever format it was saved in. */
const currentFile = async (
  value: unknown,
  changesOf: FileReads["changesOf"]
): Promise<ProjectFile> => {
  if (typeof value === "object" && value !== null) {
    const fields = value as Fields;
    if (isFormat2(fields)) {
      return fields;
    }
    if (isFormat1(fields)) {
      return fromFormat1(fields, changesOf);
    }
  }
  throw new Refusal(
    "The saved project cannot be read: its file is not a project this version of the app wrote."
  );
};

/** Reads a project file, in the format written now or the one before it. */
export const readProjectFile = async (
  text: string,
  { changesOf, sourceBytes }: FileReads
): Promise<OpenedProject> => {
  const file = await currentFile(parsed(text), changesOf);
  const sources: SourceFont[] = [];
  const sourceArtifacts = new Map<SourceId, string>();
  for (const { artifactId, ...source } of file.sources) {
    sources.push({ ...source, bytes: await sourceBytes(artifactId) });
    sourceArtifacts.set(source.id, artifactId);
  }
  return {
    activeFaceId: file.activeFaceId,
    project: {
      candidates: file.candidates.map(({ status, ...candidate }) =>
        status === "rejected" ? { ...candidate, rejected: true } : candidate
      ),
      faces: file.faces,
      head: file.head,
      name: file.name,
      // The artifact is named from the digest, so the file's copy of its id
      // is not read back.
      photographs: file.photographs.map(({ fileName, id }) => ({
        fileName,
        id,
      })),
      revisions: file.revisions,
      runs: file.runs,
      sources,
    },
    sourceArtifacts,
  };
};
