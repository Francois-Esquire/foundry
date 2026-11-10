/**
 * The Typeface Project aggregate. A project holds imported source fonts
 * untouched, the faces read from them, a history of revisions, and candidate
 * glyphs waiting for a decision. Every operation returns a new project.
 */
import {
  type Change,
  foldChanges,
  type GlyphRef,
  type Revision,
  unreachable,
  type WorkingFace,
} from "./changes";
import {
  type AxisLocation,
  clampLocation,
  type Face,
  type FaceDescription,
  type FaceId,
  isEditable,
  type SourceId,
} from "./face";
import type { Outline } from "./outline";
import type { Provenance } from "./provenance";

export interface SourceFont {
  /** The file exactly as imported. Never modified, and exported as is. */
  readonly bytes: Uint8Array;
  readonly fileName: string;
  /** The SHA-256 digest of the file, so the same file is never imported twice. */
  readonly id: SourceId;
  readonly importedAt: string;
}

export type CandidateStatus = "proposed" | "accepted" | "rejected";

/** A proposed glyph design. It stays out of the face until someone accepts it. */
export interface Candidate {
  readonly advance: number;
  readonly characters: readonly number[];
  readonly faceId: FaceId;
  readonly id: string;
  readonly name: string;
  readonly outline: Outline;
  readonly provenance: Provenance;
  /** Set when the candidate redraws an existing glyph instead of adding one. */
  readonly replaces?: GlyphRef;
  readonly status: CandidateStatus;
}

export interface TypefaceProject {
  readonly candidates: readonly Candidate[];
  readonly faces: readonly Face[];
  /** How many revisions are applied. Revisions past the head are undone. */
  readonly head: number;
  readonly name: string;
  readonly revisions: readonly Revision[];
  readonly sources: readonly SourceFont[];
}

export class ProjectError extends Error {
  override readonly name = "ProjectError";
}

export const emptyProject = (name = "Untitled project"): TypefaceProject => ({
  candidates: [],
  faces: [],
  head: 0,
  name,
  revisions: [],
  sources: [],
});

/** Hex SHA-256 of a file's bytes. */
export const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const faceIdFor = (sourceId: SourceId, index: number) =>
  `${sourceId.slice(0, 16)}:${index}`;

/** Adds a source font and one face per description. Importing the same file twice changes nothing. */
export const addSource = (
  project: TypefaceProject,
  source: SourceFont,
  descriptions: readonly FaceDescription[]
): TypefaceProject => {
  if (project.sources.some((existing) => existing.id === source.id)) {
    return project;
  }
  const faces = descriptions.map(
    (description, index): Face => ({
      description,
      id: faceIdFor(source.id, index),
      index,
      sourceId: source.id,
    })
  );
  return {
    ...project,
    faces: [...project.faces, ...faces],
    sources: [...project.sources, source],
  };
};

export const findFace = (project: TypefaceProject, faceId: FaceId): Face => {
  const face = project.faces.find((candidate) => candidate.id === faceId);
  if (!face) {
    throw new ProjectError(`This project has no face ${faceId}.`);
  }
  return face;
};

export const findSource = (
  project: TypefaceProject,
  sourceId: SourceId
): SourceFont => {
  const source = project.sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new ProjectError(`This project has no source font ${sourceId}.`);
  }
  return source;
};

export const sourceOf = (project: TypefaceProject, faceId: FaceId) =>
  findSource(project, findFace(project, faceId).sourceId);

const locationKey = (location: AxisLocation) =>
  Object.keys(location)
    .sort()
    .map((tag) => `${tag}=${location[tag]}`)
    .join(",");

/**
 * Pins one instance of a variable face so it can be edited. The variable face
 * stays in the project. Pinning the same location twice returns the same face.
 */
export const pinInstance = (
  project: TypefaceProject,
  faceId: FaceId,
  location: AxisLocation,
  styleName: string
): { readonly project: TypefaceProject; readonly face: Face } => {
  const variable = findFace(project, faceId);
  if (variable.pinned || variable.description.axes.length === 0) {
    throw new ProjectError(
      "Only a variable face can be pinned to an instance."
    );
  }
  const clamped = clampLocation(variable.description.axes, location);
  const id = `${variable.id}@${locationKey(clamped)}`;
  const existing = project.faces.find((known) => known.id === id);
  if (existing) {
    return { face: existing, project };
  }
  const face: Face = {
    ...variable,
    id,
    pinned: { location: clamped, styleName },
  };
  return { face, project: { ...project, faces: [...project.faces, face] } };
};

export interface Family {
  readonly faces: readonly Face[];
  readonly name: string;
}

/** Faces grouped by family name, lightest and narrowest first, upright before italic. */
export const families = (project: TypefaceProject): Family[] => {
  const byName = new Map<string, Face[]>();
  for (const face of project.faces) {
    const group = byName.get(face.description.familyName) ?? [];
    group.push(face);
    byName.set(face.description.familyName, group);
  }
  const rank = (face: Face) =>
    face.description.widthClass * 10_000 +
    face.description.weightClass * 2 +
    (face.description.italic ? 1 : 0);
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, faces]) => ({
      faces: faces.toSorted((a, b) => rank(a) - rank(b)),
      name,
    }));
};

/** Every change currently applied to a face, oldest first. */
export const appliedChanges = (
  project: TypefaceProject,
  faceId: FaceId
): Change[] =>
  project.revisions
    .slice(0, project.head)
    .flatMap((revision) => revision.changes)
    .filter((change) => change.faceId === faceId);

export const workingFaceOf = (
  project: TypefaceProject,
  faceId: FaceId
): WorkingFace => foldChanges(appliedChanges(project, faceId));

export const isModified = (project: TypefaceProject, faceId: FaceId) =>
  appliedChanges(project, faceId).length > 0;

const assertAdvance = (advance: number) => {
  if (!Number.isFinite(advance) || advance < 0) {
    throw new ProjectError("An advance width must be zero or more.");
  }
};

const assertChange = (
  project: TypefaceProject,
  working: WorkingFace,
  change: Change
) => {
  const face = findFace(project, change.faceId);
  if (!isEditable(face)) {
    throw new ProjectError(
      "Pin an instance of this variable face before editing it."
    );
  }
  const hasAdded = (key: string) =>
    working.added.some((glyph) => glyph.key === key);
  switch (change.kind) {
    case "outline-replaced":
    case "advance-changed":
      if (
        change.glyph.kind === "source" &&
        change.glyph.glyphId >= face.description.glyphCount
      ) {
        throw new ProjectError(
          `The source font has no glyph ${change.glyph.glyphId}.`
        );
      }
      if (change.glyph.kind === "added" && !hasAdded(change.glyph.key)) {
        throw new ProjectError(
          `This face has no added glyph ${change.glyph.key}.`
        );
      }
      if (change.kind === "advance-changed") {
        assertAdvance(change.advance);
      }
      break;
    case "glyph-added":
      if (
        hasAdded(change.glyph.key) ||
        working.added.some((glyph) => glyph.name === change.glyph.name)
      ) {
        throw new ProjectError(
          `This face already has an added glyph named ${change.glyph.name}.`
        );
      }
      assertAdvance(change.glyph.advance);
      break;
    case "glyph-removed":
      if (!hasAdded(change.key)) {
        throw new ProjectError(`This face has no added glyph ${change.key}.`);
      }
      break;
    case "features-added":
      break;
    default:
      unreachable(change);
  }
};

export interface CommitInput {
  readonly at?: string;
  readonly changes: readonly Change[];
  readonly id?: string;
  readonly label: string;
}

/**
 * Records a revision. Each change is checked against the state the earlier
 * changes produce. Committing after an undo discards the undone revisions.
 */
export const commit = (
  project: TypefaceProject,
  input: CommitInput
): TypefaceProject => {
  if (input.changes.length === 0) {
    return project;
  }
  const applied = project.revisions.slice(0, project.head);
  const pending: Change[] = applied.flatMap((earlier) => earlier.changes);
  for (const change of input.changes) {
    const working = foldChanges(
      pending.filter((earlier) => earlier.faceId === change.faceId)
    );
    assertChange(project, working, change);
    pending.push(change);
  }
  const revision: Revision = {
    changes: input.changes,
    createdAt: input.at ?? new Date().toISOString(),
    id: input.id ?? crypto.randomUUID(),
    label: input.label,
  };
  return {
    ...project,
    head: applied.length + 1,
    revisions: [...applied, revision],
  };
};

export const canUndo = (project: TypefaceProject) => project.head > 0;

export const canRedo = (project: TypefaceProject) =>
  project.head < project.revisions.length;

/** Moves the head so that exactly `head` revisions are applied. */
export const checkout = (
  project: TypefaceProject,
  head: number
): TypefaceProject => ({
  ...project,
  head: Math.min(project.revisions.length, Math.max(0, Math.trunc(head))),
});

export const undo = (project: TypefaceProject) =>
  checkout(project, project.head - 1);

export const redo = (project: TypefaceProject) =>
  checkout(project, project.head + 1);

export const propose = (
  project: TypefaceProject,
  candidates: readonly Omit<Candidate, "status">[]
): TypefaceProject => {
  for (const candidate of candidates) {
    findFace(project, candidate.faceId);
    if (project.candidates.some((existing) => existing.id === candidate.id)) {
      throw new ProjectError(`Candidate ${candidate.id} was already proposed.`);
    }
  }
  const proposed = candidates.map(
    (candidate): Candidate => ({ ...candidate, status: "proposed" })
  );
  return { ...project, candidates: [...project.candidates, ...proposed] };
};

const findCandidate = (
  project: TypefaceProject,
  candidateId: string
): Candidate => {
  const candidate = project.candidates.find(
    (existing) => existing.id === candidateId
  );
  if (!candidate) {
    throw new ProjectError(`This project has no candidate ${candidateId}.`);
  }
  return candidate;
};

const settle = (
  project: TypefaceProject,
  candidateId: string,
  status: CandidateStatus
): TypefaceProject => ({
  ...project,
  candidates: project.candidates.map((candidate) =>
    candidate.id === candidateId ? { ...candidate, status } : candidate
  ),
});

const acceptanceChanges = (candidate: Candidate): Change[] => {
  const { faceId, replaces } = candidate;
  if (replaces) {
    return [
      {
        faceId,
        glyph: replaces,
        kind: "outline-replaced",
        outline: candidate.outline,
      },
      {
        advance: candidate.advance,
        faceId,
        glyph: replaces,
        kind: "advance-changed",
      },
    ];
  }
  return [
    {
      faceId,
      glyph: {
        advance: candidate.advance,
        characters: candidate.characters,
        key: candidate.id,
        name: candidate.name,
        outline: candidate.outline,
        provenance: candidate.provenance,
      },
      kind: "glyph-added",
    },
  ];
};

/** Accepting a candidate puts its design into the face as a new revision. */
export const acceptCandidate = (
  project: TypefaceProject,
  candidateId: string,
  at?: string
): TypefaceProject => {
  const candidate = findCandidate(project, candidateId);
  if (candidate.status !== "proposed") {
    throw new ProjectError(
      `Candidate ${candidate.name} was already ${candidate.status}.`
    );
  }
  const committed = commit(project, {
    at,
    changes: acceptanceChanges(candidate),
    label: `Accept ${candidate.name}`,
  });
  return settle(committed, candidateId, "accepted");
};

export const rejectCandidate = (
  project: TypefaceProject,
  candidateId: string
): TypefaceProject => {
  const candidate = findCandidate(project, candidateId);
  if (candidate.status !== "proposed") {
    throw new ProjectError(
      `Candidate ${candidate.name} was already ${candidate.status}.`
    );
  }
  return settle(project, candidateId, "rejected");
};
