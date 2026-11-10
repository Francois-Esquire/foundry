/**
 * The Typeface Project aggregate. A project holds imported source fonts
 * untouched, the faces read from them, a history of revisions, and candidate
 * glyphs waiting for a decision. Every operation returns a new project.
 */
import {
  type AddedGlyph,
  type Change,
  type ChangeFold,
  foldChanges,
  type GlyphRef,
  type Revision,
  startFold,
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
  locationKey,
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
  /**
   * Set when the app made this file itself and no person imported it: the
   * empty font a reconstruction hangs its letters on. Such a font names no
   * licence and no owner because it has none, which is not the same as a
   * font from elsewhere that names none.
   */
  readonly madeFor?: "reconstruction";
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

const assertEdit = (face: Face, fold: ChangeFold, glyph: GlyphRef) => {
  if (glyph.kind === "source" && glyph.glyphId >= face.description.glyphCount) {
    throw new ProjectError(`The source font has no glyph ${glyph.glyphId}.`);
  }
  if (glyph.kind === "added" && !fold.hasAdded(glyph.key)) {
    throw new ProjectError(`This face has no added glyph ${glyph.key}.`);
  }
};

const assertAddition = (fold: ChangeFold, glyph: AddedGlyph) => {
  if (fold.hasAdded(glyph.key) || fold.hasAddedName(glyph.name)) {
    throw new ProjectError(
      `This face already has an added glyph named ${glyph.name}. Give the new glyph another name.`
    );
  }
  for (const character of glyph.characters) {
    const taken = fold.addedFor(character);
    if (taken) {
      const code = character.toString(16).toUpperCase().padStart(4, "0");
      throw new ProjectError(
        `U+${code} is already mapped by the added glyph ${taken.name}. Remove that glyph first, or redraw it.`
      );
    }
  }
  assertAdvance(glyph.advance);
};

const assertChange = (
  project: TypefaceProject,
  fold: ChangeFold,
  change: Change
) => {
  const face = findFace(project, change.faceId);
  if (!isEditable(face)) {
    throw new ProjectError(
      "Pin an instance of this variable face before editing it."
    );
  }
  switch (change.kind) {
    case "outline-replaced":
      assertEdit(face, fold, change.glyph);
      break;
    case "advance-changed":
      assertEdit(face, fold, change.glyph);
      assertAdvance(change.advance);
      break;
    case "glyph-added":
      assertAddition(fold, change.glyph);
      break;
    case "glyph-removed":
      if (!fold.hasAdded(change.key)) {
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
  /** The candidate this revision accepts, when that is what it does. */
  readonly accepts?: string;
  readonly at?: string;
  readonly changes: readonly Change[];
  readonly id?: string;
  readonly label: string;
}

/**
 * A candidate is accepted for exactly as long as the revision that accepted it
 * is applied. Undoing that revision returns it to proposed, and redoing it
 * accepts it again. A rejection is a decision outside the history and stays.
 */
const withCandidateStatuses = (project: TypefaceProject): TypefaceProject => {
  const accepted = new Set(
    project.revisions.slice(0, project.head).map((revision) => revision.accepts)
  );
  const statusOf = (candidate: Candidate): CandidateStatus => {
    if (accepted.has(candidate.id)) {
      return "accepted";
    }
    return candidate.status === "rejected" ? "rejected" : "proposed";
  };
  if (
    project.candidates.every(
      (candidate) => statusOf(candidate) === candidate.status
    )
  ) {
    return project;
  }
  return {
    ...project,
    candidates: project.candidates.map((candidate) => ({
      ...candidate,
      status: statusOf(candidate),
    })),
  };
};

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
  const earlier = applied.flatMap((done) => done.changes);
  const folds = new Map<FaceId, ChangeFold>();
  for (const change of input.changes) {
    let fold = folds.get(change.faceId);
    if (!fold) {
      fold = startFold(earlier.filter((past) => past.faceId === change.faceId));
      folds.set(change.faceId, fold);
    }
    assertChange(project, fold, change);
    fold.apply(change);
  }
  const revision: Revision = {
    accepts: input.accepts,
    changes: input.changes,
    createdAt: input.at ?? new Date().toISOString(),
    id: input.id ?? crypto.randomUUID(),
    label: input.label,
  };
  return withCandidateStatuses({
    ...project,
    head: applied.length + 1,
    revisions: [...applied, revision],
  });
};

/**
 * The id of the revision at the head: the last one applied. Undefined when
 * none is. Two projects with the same answer have the same changes applied,
 * which a count of revisions cannot say: an undo followed by another edit
 * leaves the count where it was.
 */
export const headRevisionId = (project: TypefaceProject): string | undefined =>
  project.revisions[project.head - 1]?.id;

export const canUndo = (project: TypefaceProject) => project.head > 0;

export const canRedo = (project: TypefaceProject) =>
  project.head < project.revisions.length;

/** Moves the head so that exactly `head` revisions are applied. */
export const checkout = (
  project: TypefaceProject,
  head: number
): TypefaceProject =>
  withCandidateStatuses({
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
  const seen = new Set(project.candidates.map((existing) => existing.id));
  for (const candidate of candidates) {
    findFace(project, candidate.faceId);
    if (seen.has(candidate.id)) {
      throw new ProjectError(`Candidate ${candidate.id} was already proposed.`);
    }
    seen.add(candidate.id);
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
        provenance: candidate.provenance,
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
  at?: string,
  revisionId?: string
): TypefaceProject => {
  const candidate = findCandidate(project, candidateId);
  if (candidate.status !== "proposed") {
    throw new ProjectError(
      `Candidate ${candidate.name} was already ${candidate.status}.`
    );
  }
  return commit(project, {
    accepts: candidate.id,
    at,
    changes: acceptanceChanges(candidate),
    id: revisionId,
    label: `Accept ${candidate.name}`,
  });
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
