/**
 * Removing a source font from a project, a rule of the project aggregate.
 * Every function returns a new project.
 */

import { count } from "~/lib/count";
import type { SourceId } from "./face";
import { findSource, ProjectError, type TypefaceProject } from "./project";

export interface RemovalOptions {
  /** Remove the source even when its faces carry work, and drop that work. */
  readonly force?: boolean;
}

/** The work that would be lost with a source font. */
export interface SourceUsage {
  /** Changes currently applied to the source's faces. */
  readonly appliedChanges: number;
  /** Candidates for the source's faces that are still waiting for a decision. */
  readonly proposedCandidates: number;
}

const faceIdsOf = (project: TypefaceProject, sourceId: SourceId) =>
  new Set(
    project.faces
      .filter((face) => face.sourceId === sourceId)
      .map((face) => face.id)
  );

export const sourceUsage = (
  project: TypefaceProject,
  sourceId: SourceId
): SourceUsage => {
  const faceIds = faceIdsOf(project, sourceId);
  return {
    appliedChanges: project.revisions
      .slice(0, project.head)
      .flatMap((revision) => revision.changes)
      .filter((change) => faceIds.has(change.faceId)).length,
    proposedCandidates: project.candidates.filter(
      (candidate) =>
        candidate.status === "proposed" && faceIds.has(candidate.faceId)
    ).length,
  };
};

const describeUsage = (usage: SourceUsage) =>
  [
    usage.appliedChanges > 0 && count(usage.appliedChanges, "applied change"),
    usage.proposedCandidates > 0 &&
      count(usage.proposedCandidates, "proposed candidate"),
  ]
    .filter((part) => part !== false)
    .join(" and ");

/**
 * Removes a source font with its faces, pinned instances included. Refuses
 * while those faces have applied changes or proposed candidates, unless
 * forced. History stays consistent either way: every change and candidate
 * that refers to a removed face goes too, undone revisions included, and so
 * does every run held for one. A revision left without changes is dropped,
 * and the head still covers exactly the revisions that were applied before.
 */
export const removeSource = (
  project: TypefaceProject,
  sourceId: SourceId,
  options: RemovalOptions = {}
): TypefaceProject => {
  const source = findSource(project, sourceId);
  const usage = sourceUsage(project, sourceId);
  if (!options.force && usage.appliedChanges + usage.proposedCandidates > 0) {
    throw new ProjectError(
      `${source.fileName} has ${describeUsage(usage)}. Undo or settle them first, or remove the font together with that work.`
    );
  }
  const faceIds = faceIdsOf(project, sourceId);
  let head = 0;
  const revisions = project.revisions.flatMap((revision, index) => {
    const changes = revision.changes.filter(
      (change) => !faceIds.has(change.faceId)
    );
    if (changes.length === 0) {
      return [];
    }
    if (index < project.head) {
      head += 1;
    }
    return changes.length === revision.changes.length
      ? [revision]
      : [{ ...revision, changes }];
  });
  return {
    ...project,
    candidates: project.candidates.filter(
      (candidate) => !faceIds.has(candidate.faceId)
    ),
    faces: project.faces.filter((face) => !faceIds.has(face.id)),
    head,
    revisions,
    runs: project.runs.filter((run) => !faceIds.has(run.faceId)),
    sources: project.sources.filter((existing) => existing.id !== sourceId),
  };
};
