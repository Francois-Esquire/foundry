/**
 * The export command. It resolves a plan the way the Export place does and
 * builds it in that place's session. No browser is here to load the font, so
 * the browser's check is left out and each font's report says it was not run.
 */
import type { BuiltFont } from "~/export/build-run";
import { planOf, startDraft } from "~/export/plan-draft";
import { builtFonts } from "~/export/session";
import { characterLookups } from "~/export/unicode-lookups";
import {
  type ExportOutput,
  type ExportResolution,
  resolveExportPlan,
} from "~/packaging/resolving";
import type { FaceId } from "~/typeface/face";
import { digestOf, findFace } from "~/typeface/project";
import type { Exported, ExportedFont, ExportRequest } from "./commands";
import { faceNamed } from "./faces";
import type { OpenProject } from "./open-project";
import { Refusal } from "./refusal";

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
  const artifactId = (await open.keepSources()).get(sourceId);
  if (artifactId === undefined) {
    throw new Error(`The source font ${sourceId} was not kept.`);
  }
  return {
    bytes: output.bytes,
    checks: [],
    digest: sourceId,
    faceId: output.faceId,
    fileName: output.fileName,
    kind: "original",
    notes: [],
    ref: { artifactId },
  };
};

/** Keeps one built font as a new version of its file name's artifact. */
const derivedFont = async (
  open: OpenProject,
  built: BuiltFont
): Promise<ExportedFont> => {
  const known = open.exports().find((kept) => kept.fileName === built.fileName);
  const ref = await open.store.keepExport(known?.artifactId, {
    checks: {
      builtAt: built.builtAt,
      checks: built.report.checks,
      faceId: built.faceId,
      notes: built.notes,
      passed: built.report.passed,
      revisionId: built.revisionId,
    },
    fileName: built.fileName,
    font: built.bytes,
  });
  open.noteExport({
    artifactId: ref.artifactId,
    fileName: built.fileName,
    versions: (known?.versions ?? 0) + 1,
  });
  return {
    bytes: built.bytes,
    checks: built.report.checks,
    // The digest of the font alone: the checks beside it carry a time.
    digest: await digestOf(built.bytes),
    faceId: built.faceId,
    fileName: built.fileName,
    kind: "derived",
    notes: built.notes,
    ref,
  };
};

/**
 * The same builds with the application's time as each font's modified time,
 * so the same project and the same clock give the same bytes.
 */
const stamped = (
  resolution: ExportResolution,
  modifiedAt: string
): ExportResolution => ({
  ...resolution,
  outputs: resolution.outputs.map((output) =>
    output.kind === "derived"
      ? { ...output, request: { ...output.request, modifiedAt } }
      : output
  ),
});

export const exportFonts = async (
  open: OpenProject,
  request: ExportRequest
): Promise<Exported> => {
  const { means, places, workspace } = open;
  const { project } = workspace.getState();
  const charactersOfFace = (faceId: FaceId) =>
    workspace.openFace(faceId).characters();
  const draft = {
    ...startDraft(undefined),
    faceIds: request.faces.map((name) => faceNamed(project, name).id),
    familyName: request.familyName ?? "",
  };
  const drafted = planOf(draft, project);
  // The command offers no choice of language, so no language data is loaded.
  const resolution = resolveExportPlan(
    project,
    drafted.plan,
    characterLookups([], charactersOfFace)
  );
  const warnings = resolution.warnings.map((finding) => finding.message);
  const problems = [
    ...drafted.problems,
    ...resolution.problems.map((finding) => finding.message),
  ];
  if (problems.length > 0) {
    return { fonts: [], problems, warnings };
  }
  if (places.export.getState().run?.running) {
    throw new Refusal(
      "A build is already running. Wait for it to end, then export again."
    );
  }
  await places.export.build(
    { draft, project },
    stamped(resolution, means.now())
  );
  const state = places.export.getState();
  const built = builtFonts(state);
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
  const failed = (state.run?.outputs ?? []).flatMap((output) =>
    output.progress.status === "failed"
      ? [`${output.fileName} was not built. ${output.progress.message}`]
      : []
  );
  return { fonts, problems: failed, warnings };
};
