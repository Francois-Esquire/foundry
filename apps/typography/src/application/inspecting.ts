/** The inspect command: what the project holds now, as plain data. */
import { readFaceCoverage } from "~/library/face-coverage";
import { type Face, faceListLabel, isEditable } from "~/typeface/face";
import {
  type Candidate,
  candidatesWithStatus,
  waitingRuns,
} from "~/typeface/project";
import { generationRunId } from "~/typeface/provenance";
import { coverageOf } from "~/unicode/coverage";
import type {
  InspectedFace,
  Inspection,
  ScriptCoverage,
  WaitingCandidate,
} from "./application";
import { photographArtifact } from "./artifact-store";
import { EXTENSION_PLANS } from "./extension-plans";
import type { OpenProject } from "./open-project";

const coverageOfFace = (open: OpenProject, face: Face): ScriptCoverage[] => {
  const { project } = open.workspace.getState();
  const { byScope, classification } = readFaceCoverage(
    project,
    face.id,
    open.workspace.openFace(face.id)
  );
  const touched = byScope.map(
    ({ counts, covered, name, scope, total }): ScriptCoverage => ({
      candidates: counts.candidate,
      covered,
      name,
      script: scope.kind === "script" ? scope.code : undefined,
      total,
    })
  );
  const listed = new Set(touched.map((entry) => entry.script));
  // A script an extension is planned for is listed even at nothing, so
  // coverage answers "does this face have it" before and after.
  const planned = Object.values(EXTENSION_PLANS)
    .filter((plan) => !listed.has(plan.iso15924))
    .map(({ iso15924, script }): ScriptCoverage => {
      const { counts, covered, total } = coverageOf(
        { code: iso15924, kind: "script" },
        classification.classify
      );
      return {
        candidates: counts.candidate,
        covered,
        name: script,
        script: iso15924,
        total,
      };
    });
  return [...touched, ...planned];
};

const inspectFace = (open: OpenProject, face: Face): InspectedFace => ({
  coverage: coverageOfFace(open, face),
  editable: isEditable(face),
  faceId: face.id,
  label: faceListLabel(face),
  sourceFont: open.sourceArtifact(face.sourceId),
});

export const inspect = (open: OpenProject): Inspection => {
  const { project } = open.workspace.getState();
  return {
    // By file name, so the list reads the same before and after a reopening.
    exports: open
      .exports()
      .toSorted((a, b) => a.fileName.localeCompare(b.fileName, "en")),
    faces: project.faces.map((face) => inspectFace(open, face)),
    name: project.name,
    photographs: project.photographs.map(({ fileName, id }) => ({
      artifactId: photographArtifact(id),
      fileName,
    })),
    revisions: project.head,
    waiting: {
      candidates: candidatesWithStatus(project, "proposed").map(
        (candidate: Candidate): WaitingCandidate => ({
          faceId: candidate.faceId,
          id: candidate.id,
          name: candidate.name,
          origin: candidate.provenance.origin,
          runId: generationRunId(candidate.provenance),
          text: String.fromCodePoint(...candidate.characters),
          verdict: candidate.verdict,
        })
      ),
      // Named field by field: a run's changes are the project's, not an answer.
      runs: waitingRuns(project).map(
        ({ faceId, glyphs, modelOutput, runId, script }) => ({
          faceId,
          glyphs,
          modelOutput,
          runId,
          script,
        })
      ),
    },
  };
};
