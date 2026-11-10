/**
 * The workspace: the one open Typeface Project, the active face, and the
 * notices on screen. Screens read immutable snapshots and act through the use
 * cases here, which keep the project, the open faces and the notices in step.
 */
import {
  type Change,
  type GlyphRef,
  resolveGlyph,
  type WorkingFace,
} from "~/typeface/changes";
import type { AxisLocation, Face, FaceId, SourceId } from "~/typeface/face";
import {
  acceptCandidate,
  addSource,
  type Candidate,
  checkout,
  commit,
  digestOf,
  emptyProject,
  findFace,
  findSource,
  ProjectError,
  pinInstance,
  propose,
  redo,
  rejectCandidate,
  type TypefaceProject,
  undo,
  workingFaceOf,
} from "~/typeface/project";
import type { FontReader, GlyphShape, OpenFace } from "~/typeface/reading";
import { type RemovalOptions, removeSource } from "~/typeface/removal";
import { type GlyphEntry, glyphForCharacter, listGlyphs } from "./glyphs";
import {
  closeFaces,
  duplicateMessage,
  type ImportFile,
  type ImportReport,
  openEveryFace,
  rejectionMessage,
  rejectionReason,
} from "./importing";
import {
  type Notice,
  type NoticeTone,
  type Outcome,
  withNotice,
  withoutNotice,
} from "./notices";
import { createOpenFaces } from "./open-faces";

export interface WorkspaceState {
  readonly activeFaceId: FaceId | undefined;
  readonly notices: readonly Notice[];
  readonly project: TypefaceProject;
}

export interface WorkspaceDependencies {
  /** Ids for notices and revisions. */
  readonly newId: () => string;
  /** The current time as an ISO 8601 string. */
  readonly now: () => string;
  readonly reader: FontReader;
}

interface OriginalFile {
  /** The identical bytes that were imported, not a copy. */
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

/**
 * Use cases that can fail return an Outcome. A failure has already been added
 * to the notices, so a caller only needs the result to decide what to do next.
 * The reading helpers at the end change nothing and are safe to call while
 * rendering; they throw ProjectError for a face the project does not have.
 */
export interface Workspace {
  acceptCandidate(candidateId: string): Outcome;
  apply(label: string, changes: readonly Change[]): Outcome;
  checkout(head: number): void;
  dismissNotice(noticeId: string): void;
  exportOriginal(sourceId: SourceId): Outcome<OriginalFile>;
  getState(): WorkspaceState;
  /** The glyph a character currently maps to before shaping, counting added glyphs. */
  glyphForCharacter(faceId: FaceId, codePoint: number): GlyphRef | undefined;
  /** Every glyph in a face. The same list is returned until the project changes. */
  glyphsOf(faceId: FaceId): readonly GlyphEntry[];
  /** Never rejects: a file that cannot be imported gets a notice and a report. */
  importFonts(files: readonly ImportFile[]): Promise<ImportReport[]>;
  /** The face for reading and shaping. Shared, and closed when its source is removed. */
  openFace(faceId: FaceId): OpenFace;
  pinInstance(
    faceId: FaceId,
    location: AxisLocation,
    styleName: string
  ): Outcome<Face>;
  propose(candidates: readonly Omit<Candidate, "status">[]): Outcome;
  redo(): void;
  rejectCandidate(candidateId: string): Outcome;
  removeSource(sourceId: SourceId, options?: RemovalOptions): Outcome;
  renameProject(name: string): Outcome;
  setActiveFace(faceId: FaceId): Outcome;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
  undo(): void;
  /** A face's applied changes as one view. The same object is returned until its history moves. */
  workingFace(faceId: FaceId): WorkingFace;
  /** The glyph as the project currently has it. Undefined for an added glyph that is gone. */
  workingGlyph(faceId: FaceId, ref: GlyphRef): GlyphShape | undefined;
}

interface FaceReading {
  glyphs?: readonly GlyphEntry[];
  readonly working: WorkingFace;
}

export const createWorkspace = ({
  reader,
  now,
  newId,
}: WorkspaceDependencies): Workspace => {
  let state: WorkspaceState = {
    activeFaceId: undefined,
    notices: [],
    project: emptyProject(),
  };
  const listeners = new Set<() => void>();
  const openFaces = createOpenFaces(reader);
  // Keyed on the history, not the project: renaming the project or proposing
  // a candidate leaves every face's glyphs as they were.
  const readings = new WeakMap<
    TypefaceProject["revisions"],
    Map<string, FaceReading>
  >();
  const sourceNames = new Map<string, ReadonlySet<string>>();

  const setState = (next: Partial<WorkspaceState>) => {
    const merged = { ...state, ...next };
    if (
      merged.project === state.project &&
      merged.notices === state.notices &&
      merged.activeFaceId === state.activeFaceId
    ) {
      return;
    }
    state = merged;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const notify = (message: string, tone: NoticeTone): Notice => {
    const { notice, notices } = withNotice(state.notices, {
      id: newId(),
      message,
      tone,
    });
    setState({ notices });
    return notice;
  };

  /** Runs a use case. A ProjectError becomes a notice; anything else is a bug and propagates. */
  const attempt = <T>(useCase: () => T): Outcome<T> => {
    try {
      return { ok: true, value: useCase() };
    } catch (error) {
      if (!(error instanceof ProjectError)) {
        throw error;
      }
      return { notice: notify(error.message, "error"), ok: false };
    }
  };

  const change = (
    next: (project: TypefaceProject) => TypefaceProject
  ): Outcome =>
    attempt(() => {
      setState({ project: next(state.project) });
    });

  /** Moving the head to where it already is leaves the snapshot alone. */
  const moveHead = (moved: TypefaceProject) => {
    if (moved.head !== state.project.head) {
      setState({ project: moved });
    }
  };

  const readingOf = (faceId: FaceId): FaceReading => {
    const { project } = state;
    findFace(project, faceId);
    let faces = readings.get(project.revisions);
    if (!faces) {
      faces = new Map();
      readings.set(project.revisions, faces);
    }
    const key = `${project.head}:${faceId}`;
    let reading = faces.get(key);
    if (!reading) {
      reading = { working: workingFaceOf(project, faceId) };
      faces.set(key, reading);
    }
    return reading;
  };

  const openFace = (faceId: FaceId) => openFaces.open(state.project, faceId);

  /** The glyph names of a face's source font, read once per source. */
  const sourceNamesOf = (faceId: FaceId): ReadonlySet<string> => {
    const { sourceId, index } = findFace(state.project, faceId);
    const key = `${sourceId}:${index}`;
    let names = sourceNames.get(key);
    if (!names) {
      const face = openFace(faceId);
      names = new Set(
        Array.from({ length: face.description.glyphCount }, (_, glyphId) =>
          face.glyphName(glyphId)
        )
      );
      sourceNames.set(key, names);
    }
    return names;
  };

  /**
   * A built font cannot hold two glyphs with one name, and feature code finds
   * glyphs by name, so a new glyph may not take a name the source font uses.
   */
  const assertFreshNames = (changes: readonly Change[]) => {
    for (const entry of changes) {
      if (
        entry.kind === "glyph-added" &&
        sourceNamesOf(entry.faceId).has(entry.glyph.name)
      ) {
        throw new ProjectError(
          `The source font already has a glyph named ${entry.glyph.name}. Give the new glyph another name.`
        );
      }
    }
  };

  const importFont = async (file: ImportFile): Promise<ImportReport> => {
    let faces: OpenFace[];
    try {
      faces = openEveryFace(reader, file.bytes);
    } catch (error) {
      const reason = rejectionReason(file.bytes, error);
      notify(rejectionMessage(file.name, reason), "error");
      return { fileName: file.name, reason, status: "rejected" };
    }
    const sourceId = await digestOf(file.bytes);
    // The project may have changed while the digest was computed, so read it only now.
    const existing = state.project.sources.find(
      (source) => source.id === sourceId
    );
    if (existing) {
      closeFaces(faces);
      notify(duplicateMessage(file.name, existing.fileName), "info");
      return { fileName: file.name, sourceId, status: "duplicate" };
    }
    const project = addSource(
      state.project,
      {
        bytes: file.bytes,
        fileName: file.name,
        id: sourceId,
        importedAt: now(),
      },
      faces.map((face) => face.description)
    );
    openFaces.adopt(sourceId, faces);
    const faceIds = project.faces
      .filter((face) => face.sourceId === sourceId)
      .map((face) => face.id);
    setState({ activeFaceId: state.activeFaceId ?? faceIds[0], project });
    return { faceIds, fileName: file.name, sourceId, status: "imported" };
  };

  return {
    acceptCandidate: (candidateId) =>
      change((project) => {
        const candidate = project.candidates.find(
          (entry) => entry.id === candidateId
        );
        if (candidate && !candidate.replaces) {
          assertFreshNames([
            {
              faceId: candidate.faceId,
              glyph: { ...candidate, key: candidate.id },
              kind: "glyph-added",
            },
          ]);
        }
        return acceptCandidate(project, candidateId, now(), newId());
      }),
    apply: (label, changes) =>
      change((project) => {
        assertFreshNames(changes);
        return commit(project, { at: now(), changes, id: newId(), label });
      }),
    checkout: (head) => moveHead(checkout(state.project, head)),
    dismissNotice: (noticeId) =>
      setState({ notices: withoutNotice(state.notices, noticeId) }),
    exportOriginal: (sourceId) =>
      attempt(() => {
        const source = findSource(state.project, sourceId);
        return { bytes: source.bytes, fileName: source.fileName };
      }),
    getState: () => state,
    glyphForCharacter: (faceId, codePoint) =>
      glyphForCharacter(readingOf(faceId).working, openFace(faceId), codePoint),
    glyphsOf: (faceId) => {
      const reading = readingOf(faceId);
      reading.glyphs ??= listGlyphs(reading.working, openFace(faceId));
      return reading.glyphs;
    },
    importFonts: async (files) => {
      const reports: ImportReport[] = [];
      for (const file of files) {
        // One at a time, so reports and notices follow the order of the files.
        reports.push(await importFont(file));
      }
      return reports;
    },
    openFace,
    pinInstance: (faceId, location, styleName) =>
      attempt(() => {
        const pinned = pinInstance(state.project, faceId, location, styleName);
        setState({ project: pinned.project });
        return pinned.face;
      }),
    propose: (candidates) => change((project) => propose(project, candidates)),
    redo: () => moveHead(redo(state.project)),
    rejectCandidate: (candidateId) =>
      change((project) => rejectCandidate(project, candidateId)),
    removeSource: (sourceId, options) =>
      attempt(() => {
        const project = removeSource(state.project, sourceId, options);
        openFaces.release(sourceId);
        for (const key of [...sourceNames.keys()]) {
          if (key.startsWith(`${sourceId}:`)) {
            sourceNames.delete(key);
          }
        }
        const activeSurvives = project.faces.some(
          (face) => face.id === state.activeFaceId
        );
        setState({
          activeFaceId: activeSurvives
            ? state.activeFaceId
            : project.faces[0]?.id,
          project,
        });
      }),
    renameProject: (name) =>
      change((project) => {
        const trimmed = name.trim();
        if (!trimmed) {
          throw new ProjectError(
            "A project needs a name. Type one and try again."
          );
        }
        return trimmed === project.name
          ? project
          : { ...project, name: trimmed };
      }),
    setActiveFace: (faceId) =>
      attempt(() => {
        setState({ activeFaceId: findFace(state.project, faceId).id });
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    undo: () => moveHead(undo(state.project)),
    workingFace: (faceId) => readingOf(faceId).working,
    workingGlyph: (faceId, ref) => {
      const face = openFace(faceId);
      return resolveGlyph(readingOf(faceId).working, ref, (glyphId) =>
        face.glyph(glyphId)
      );
    },
  };
};
