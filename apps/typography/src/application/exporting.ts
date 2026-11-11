/**
 * The export command. It resolves a plan and builds it the way the Export
 * place does, with the same two operations. No browser is here to load the
 * font, so the browser's check is left out and each font's report says it
 * was not run.
 */

import { sha256Hex } from "@foundry/lib/digest";
import { type BuiltFont, builtOf, runBuilds } from "~/export/build-run";
import { resolveDraft, startDraft } from "~/export/plan-draft";
import { characterLookups } from "~/export/unicode-lookups";
import type { ExportOutput } from "~/packaging/resolving";
import type { FaceId } from "~/typeface/face";
import { findFace, headRevisionId } from "~/typeface/project";
import type { Exported, ExportedFont, ExportRequest } from "./commands";
import { faceNamed } from "./faces";
import type { OpenProject } from "./open-project";

type Original = Extract<ExportOutput, { readonly kind: "original" }>;

/** A source file leaves as it arrived, so the artifact it is already kept in is the export. */
const originalFont = async (
  open: OpenProject,
  output: Original
): Promise<ExportedFont> => {
  const { sourceId } = findFace(
    open.workspace.getState().project,
    output.faceId
  );
  const artifactOf = await open.keepSources();
  return {
    bytes: output.bytes,
    checks: [],
    digest: sourceId,
    faceId: output.faceId,
    fileName: output.fileName,
    kind: "original",
    notes: [],
    ref: { artifactId: artifactOf(sourceId) },
  };
};

/** Keeps one built font as a new version of its file name's artifact. */
const derivedFont = async (
  open: OpenProject,
  built: BuiltFont
): Promise<ExportedFont> => {
  const known = open
    .exports()
    .find((earlier) => earlier.fileName === built.fileName);
  const { contentId, ...kept } = await open.store.keepExport(
    known?.artifactId,
    built
  );
  open.noteExport(kept);
  return {
    bytes: built.bytes,
    checks: built.report.checks,
    // The digest of the font alone: the checks beside it carry a time.
    digest: await sha256Hex(built.bytes),
    faceId: built.faceId,
    fileName: built.fileName,
    kind: "derived",
    notes: built.notes,
    ref: { artifactId: kept.artifactId, contentId },
  };
};

export const exportFonts = async (
  open: OpenProject,
  request: ExportRequest
): Promise<Exported> => {
  const { means, workspace } = open;
  const { project } = workspace.getState();
  const charactersOfFace = (faceId: FaceId) =>
    workspace.openFace(faceId).characters();
  const draft = {
    ...startDraft(undefined),
    faceIds: request.faces.map((name) => faceNamed(project, name).id),
    familyName: request.familyName ?? "",
  };
  // The command offers no choice of language, so no language data is loaded.
  const { resolution, typingProblems } = resolveDraft(
    project,
    draft,
    characterLookups([], charactersOfFace)
  );
  const warnings = resolution.warnings.map((finding) => finding.message);
  const problems = [
    ...typingProblems,
    ...resolution.problems.map((finding) => finding.message),
  ];
  if (problems.length > 0) {
    return { fonts: [], problems, warnings };
  }
  const outputs = await runBuilds(
    resolution,
    {
      builder: means.builder,
      charactersOfFace,
      clock: means.clock,
      newId: means.newId,
      reader: means.reader,
    },
    headRevisionId(project)
  );
  const built = builtOf(outputs);
  const fonts: ExportedFont[] = [];
  // In the order of the plan, whether a file was built or passed through.
  for (const output of resolution.outputs) {
    if (output.kind === "original") {
      fonts.push(await originalFont(open, output));
      continue;
    }
    const font = built.find(
      (made) =>
        made.faceId === output.faceId && made.fileName === output.fileName
    );
    if (font) {
      fonts.push(await derivedFont(open, font));
    }
  }
  const failed = outputs.flatMap((output) =>
    output.progress.status === "failed"
      ? [`${output.fileName} was not built. ${output.progress.message}`]
      : []
  );
  return { fonts, problems: failed, warnings };
};
