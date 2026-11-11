import "./proof.css";
import { useMemo } from "react";
import type { BuiltFont } from "~/export/build-run";
import { exportFaceHash } from "~/export/export-address";
import { type FaceFacts, faceFacts } from "~/export/face-facts";
import { formatSize, formatTime } from "~/export/results-section";
import { builtFonts, changedSinceBuilt } from "~/export/session";
import { useExportSession } from "~/export/use-export";
import { type FaceId, faceListLabel } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { EmptyState } from "~/ui/content/empty-state";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Select } from "~/ui/controls/select";
import { RuledSection } from "~/ui/layout/ruled-section";
import { useActiveFace, useProject } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";
import { GlyphsSection } from "./glyphs-section";
import {
  type SubjectRef,
  subjectAddress,
  subjectKey,
  subjectOfKey,
  subjectOfPath,
  textOfPath,
} from "./proof-address";
import type { ProofFont } from "./proof-subject";
import { RegressionSection } from "./regression-section";
import { ShapingSection } from "./shaping-section";
import { TextSection } from "./text-section";
import { useBrowserFont, useProof, useWorkingBuild } from "./use-proof";
import { ValidatorSection } from "./validator-section";
import type { WorkingBuild } from "./working-builds";

const number = (value: number) => value.toLocaleString("en");

/** The font on the desk: what it is, and every comparison with its source. */
function ProofBody({
  asked,
  font,
  sourceLabel,
}: {
  /** The text the address asks to be set, when it names one. */
  readonly asked: string | undefined;
  readonly font: ProofFont;
  readonly sourceLabel: string;
}) {
  const state = useProof(font);
  const browserFont = useBrowserFont(font);
  const proof = state.status === "proved" ? state.proof : undefined;
  return (
    <>
      <div className="ty-proof-facts" data-testid="proof-facts">
        <TitleBlock>
          <TitleBlockItem label="Font" weight={2}>
            {font.fileName}
          </TitleBlockItem>
          <TitleBlockItem label="Source face" weight={2}>
            {sourceLabel}
          </TitleBlockItem>
          <TitleBlockItem label="Reopens as" weight={2}>
            {proof
              ? `${proof.description.familyName} ${proof.description.styleName}`
              : "Not yet reopened"}
          </TitleBlockItem>
          <TitleBlockItem label="Characters">
            {proof ? number(proof.description.characterCount) : "Unknown"}
          </TitleBlockItem>
          <TitleBlockItem label="Glyphs">
            {proof ? number(proof.description.glyphCount) : "Unknown"}
          </TitleBlockItem>
          <TitleBlockItem label="Size">
            {formatSize(font.bytes.byteLength)}
          </TitleBlockItem>
          <TitleBlockItem label="Built at">
            {formatTime(font.builtAt)}
          </TitleBlockItem>
        </TitleBlock>
      </div>
      {state.status === "proving" ? (
        <ProgressLine label="Reopening the font and comparing it with its source" />
      ) : null}
      {state.status === "failed" ? (
        <Notice tone="problem">
          This font could not be proved: {state.message} Build it again, and if
          it fails again the build is at fault.
        </Notice>
      ) : null}
      {proof ? (
        <>
          <TextSection
            asked={asked}
            browserFont={browserFont}
            font={font}
            key={asked ?? ""}
            proof={proof}
          />
          <ShapingSection browserFont={browserFont} font={font} proof={proof} />
          <RegressionSection browserFont={browserFont} proof={proof} />
          <GlyphsSection proof={proof} />
          <ValidatorSection font={font} />
        </>
      ) : null}
    </>
  );
}

/** A proof needs the source face to compare with, so it says so when that face is gone. */
function SourcedProof({
  asked,
  font,
  sourceLabel,
}: {
  readonly asked: string | undefined;
  readonly font: ProofFont;
  readonly sourceLabel: string | undefined;
}) {
  return sourceLabel === undefined ? (
    <Notice tone="problem">
      The source font of {font.fileName} is no longer in the project, so there
      is nothing to compare it with. Import the source font again and build the
      export again.
    </Notice>
  ) : (
    <ProofBody
      asked={asked}
      font={font}
      key={font.id}
      sourceLabel={sourceLabel}
    />
  );
}

/** Building a working face on demand, with every state of the build said in words. */
function WorkingBuildControls({
  build,
  label,
  onBuild,
  outdated,
}: {
  readonly build: WorkingBuild;
  readonly label: string;
  readonly onBuild: () => void;
  readonly outdated: boolean;
}) {
  const engine = useEngineStatus();
  return (
    <div className="ty-proof-stack">
      <div className="ty-proof-actions">
        <Button
          disabled={build.status === "building"}
          onClick={onBuild}
          variant="solid"
        >
          {build.status === "built"
            ? "Build and prove again"
            : "Build and prove"}
        </Button>
        <p>
          Builds {label} as the project has it now, with every applied change,
          and proves the result. The build stays in this place and is not an
          export.
        </p>
      </div>
      {build.status === "building" ? (
        <ProgressLine
          label={
            engine === "starting"
              ? "Starting the font engine"
              : `Building ${label}`
          }
        />
      ) : null}
      {build.status === "failed" ? (
        <Notice
          action={<Button onClick={onBuild}>Build again</Button>}
          tone="problem"
        >
          {label} was not built. {build.message}
        </Notice>
      ) : null}
      {outdated ? (
        <Notice>
          The project has changed since this face was built. Build and prove
          again to see it as it is now.
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * Said above the proof of a font Export built, once the project's revisions
 * have moved on: the proof is of the file, and the file is behind.
 */
function StaleBuildNotice({
  font,
  project,
}: {
  readonly font: BuiltFont;
  readonly project: TypefaceProject;
}) {
  if (!changedSinceBuilt(font, project)) {
    return null;
  }
  return (
    <Notice
      action={
        // The bare address: one that names a face would change the plan the
        // file was built from.
        <ButtonLink href="#/export">Build it again in Export</ButtonLink>
      }
    >
      The project has changed since {font.fileName} was built. This proof is of
      the file as it was built, not of the project as it is now. Build it again
      in Export to bring it up to date, or choose the working face from the list
      to prove the project as it stands.
    </Notice>
  );
}

const asProofFont = (font: BuiltFont): ProofFont => ({
  builtAt: font.builtAt,
  bytes: font.bytes,
  exported: true,
  faceId: font.faceId,
  fileName: font.fileName,
  id: font.id,
  request: font.request,
  samples: font.samples,
});

/** The subject the address names, when the session and the project still hold it. */
const presentSubject = (
  named: SubjectRef | undefined,
  built: readonly BuiltFont[],
  faces: readonly FaceFacts[]
): SubjectRef | undefined => {
  if (named?.kind === "built") {
    return built.some((font) => font.id === named.id) ? named : undefined;
  }
  return named && faces.some(({ face }) => face.id === named.faceId)
    ? named
    : undefined;
};

const chooseSubject = (key: string) => {
  const subject = subjectOfKey(key);
  if (subject) {
    window.location.hash = subjectAddress(subject);
  }
};

function ProofDesk({
  activeFaceId,
  path,
  project,
}: {
  /** The face a proof starts from when the address names nothing and nothing is built. */
  readonly activeFaceId: FaceId;
  readonly path: readonly string[];
  readonly project: TypefaceProject;
}) {
  const { state } = useExportSession();
  const built = useMemo(() => builtFonts(state), [state]);
  const faces = useMemo(() => faceFacts(project), [project]);
  const labelOf = (id: string) =>
    faces.find(({ face }) => face.id === id)?.label;

  const named = subjectOfPath(path);
  const present = presentSubject(named, built, faces);
  const [firstBuilt] = built;
  const subject: SubjectRef =
    present ??
    (firstBuilt
      ? { id: firstBuilt.id, kind: "built" }
      : { faceId: activeFaceId, kind: "face" });

  const faceId = subject.kind === "face" ? subject.faceId : undefined;
  const faceName = (faceId && labelOf(faceId)) ?? "";
  const working = useWorkingBuild(faceId, faceName);
  const builtSubject =
    subject.kind === "built"
      ? built.find((candidate) => candidate.id === subject.id)
      : undefined;
  const exported = useMemo(
    () => builtSubject && asProofFont(builtSubject),
    [builtSubject]
  );
  const font =
    exported ??
    (working.build.status === "built" ? working.build.font : undefined);

  const options = [
    ...built.map((candidate) => ({
      label: `${candidate.fileName}, built at ${formatTime(candidate.builtAt)}${
        changedSinceBuilt(candidate, project)
          ? ", before the project changed"
          : ""
      }`,
      value: subjectKey({ id: candidate.id, kind: "built" }),
    })),
    ...faces.map(({ face }) => ({
      label: `${faceListLabel(face)}, the working face`,
      value: subjectKey({ faceId: face.id, kind: "face" }),
    })),
  ];

  return (
    <div className="ty-proof">
      <RuledSection
        first
        heading="Proof"
        lede="Prove a built font before trusting it. The font's real bytes are reopened and compared with the source font: in text, in shaping, pixel by pixel, and glyph by glyph."
      >
        <div className="ty-proof-stack">
          {path.length > 0 && !named ? (
            <Notice>
              This address names no font to prove. Choose one from the list
              below.
            </Notice>
          ) : null}
          {named && !present ? (
            <Notice>
              The font this address names is no longer here. Fonts built in
              Export are kept until the next build or until the page is closed.
            </Notice>
          ) : null}
          <div className="ty-proof-subject">
            <Select
              label="Font to prove"
              onChange={chooseSubject}
              options={options}
              value={subjectKey(subject)}
            />
            {built.length === 0 ? (
              <p className="ty-proof-hint">
                Nothing has been built in Export yet, so only working faces are
                listed. Plan an export to prove the file you will ship.
              </p>
            ) : null}
          </div>
          {builtSubject ? (
            <StaleBuildNotice font={builtSubject} project={project} />
          ) : null}
          {subject.kind === "face" ? (
            <WorkingBuildControls
              build={working.build}
              label={faceName}
              onBuild={working.start}
              outdated={
                working.build.status === "built" &&
                working.build.project !== project
              }
            />
          ) : null}
          {subject.kind === "face" ? (
            <div className="ty-proof-actions">
              <ButtonLink href={exportFaceHash(subject.faceId)}>
                Plan an export
              </ButtonLink>
              <p>
                Export opens with {faceName} chosen. A file to ship comes from
                there, renamed and checked against the licence.
              </p>
            </div>
          ) : null}
        </div>
      </RuledSection>
      {font ? (
        <SourcedProof
          asked={textOfPath(path)}
          font={font}
          sourceLabel={labelOf(font.faceId)}
        />
      ) : null}
    </div>
  );
}

/** Proof: a built font, or a working face built on demand, compared with its source. */
export default function ProofScreen({
  path,
}: {
  readonly path: readonly string[];
}) {
  const project = useProject();
  const active = useActiveFace();
  if (!active) {
    return (
      <EmptyState
        action={
          <ButtonLink href="#/import" symbol="add">
            Import a font
          </ButtonLink>
        }
        symbol="proof"
        title="Nothing to prove yet"
      >
        A built font is compared with its source font here: in text, in shaping,
        pixel by pixel. Import a font, or load the samples, to begin.
      </EmptyState>
    );
  }
  return <ProofDesk activeFaceId={active.id} path={path} project={project} />;
}
