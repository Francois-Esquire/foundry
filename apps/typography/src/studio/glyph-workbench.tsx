import { useCallback, useMemo, useState } from "react";
import { exportFaceHash } from "~/export/export-address";
import { subjectAddress } from "~/proof/proof-address";
import {
  addedGlyph,
  type GlyphRef,
  glyphRefKey,
  sameGlyph,
} from "~/typeface/changes";
import {
  type AxisLocation,
  defaultLocation,
  type Face,
  faceName,
  isEditable,
} from "~/typeface/face";
import type { GlyphEntry } from "~/typeface/glyphs";
import {
  type Candidate,
  pinnedInstancesOf,
  type TypefaceProject,
} from "~/typeface/project";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { SplitView } from "~/ui/layout/split-view";
import { useWorkspace } from "~/workspace/react";
import type { Measure } from "./bearings";
import { CandidatesPanel } from "./candidates-panel";
import { CanvasToolbar } from "./canvas-toolbar";
import { type CanvasTool, GlyphCanvas } from "./glyph-canvas";
import { GlyphChooser } from "./glyph-chooser";
import { GlyphDrawing } from "./glyph-drawing";
import { startingGlyph } from "./glyph-finding";
import { type Comparison, GlyphInspector } from "./glyph-inspector";
import { GlyphTitle } from "./glyph-title";
import { measureFieldId } from "./measure-table";
import { PinPanel } from "./pin-panel";
import { SpecimenSections } from "./specimen-sections";
import { openInStudio } from "./studio-address";
import { useHistorySteps } from "./use-glyph-editor";
import { useOpenGlyph } from "./use-open-glyph";

const SOURCE_HEIGHT = 220;
const INSPECTOR_WIDTH = 340;

/** Takes the person from a callout on the drawing to its number in the table. */
const goToMeasure = (measure: Measure) => {
  const field = document.getElementById(measureFieldId(measure));
  if (field instanceof HTMLInputElement) {
    // The press that asked for this would take focus straight back.
    requestAnimationFrame(() => {
      field.focus();
      field.select();
    });
  }
};

interface FaceWorkbenchProps {
  readonly entries: readonly GlyphEntry[];
  readonly entry: GlyphEntry;
  readonly face: Face;
  readonly project: TypefaceProject;
}

function FaceWorkbench({ entries, entry, face, project }: FaceWorkbenchProps) {
  const workspace = useWorkspace();
  const [tool, setTool] = useState<CanvasTool>("select");
  const [comparison, setComparison] = useState<Comparison>("over");
  const [location, setLocation] = useState<AxisLocation>(() =>
    defaultLocation(face.description.axes)
  );
  const open = useOpenGlyph(project, face, entry, location);
  const { editor, glyph, shape, source } = open;
  const editable = isEditable(face);
  const sourceFont = project.sources.find(
    (known) => known.id === face.sourceId
  );
  const candidates = useMemo(
    () =>
      project.candidates.filter((candidate) => candidate.faceId === face.id),
    [face.id, project.candidates]
  );
  const pinned = useMemo(
    () => pinnedInstancesOf(project, face),
    [face, project]
  );

  const { redo, undo } = useHistorySteps(workspace, editor);
  const chooseFace = useCallback(
    (faceId: string) => {
      workspace.setActiveFace(faceId);
      openInStudio(faceId);
    },
    [workspace]
  );
  const openGlyph = useCallback(
    (ref: GlyphRef) => openInStudio(face.id, ref),
    [face.id]
  );
  const shapeOf = useCallback(
    (ref: GlyphRef) => workspace.workingGlyph(face.id, ref),
    [face.id, workspace]
  );
  const pin = useCallback(
    (at: AxisLocation, styleName: string) => {
      const outcome = workspace.pinInstance(face.id, at, styleName);
      if (outcome.ok) {
        workspace.setActiveFace(outcome.value.id);
        openInStudio(outcome.value.id, glyph);
      }
    },
    [face.id, glyph, workspace]
  );
  const accept = useCallback(
    (candidate: Candidate) => {
      editor?.flush();
      if (workspace.acceptCandidate(candidate.id).ok) {
        openInStudio(face.id, candidate.replaces ?? addedGlyph(candidate.id));
      }
    },
    [editor, face.id, workspace]
  );
  const reject = useCallback(
    (candidate: Candidate) => workspace.rejectCandidate(candidate.id),
    [workspace]
  );

  if (!shape) {
    return (
      <Notice tone="problem">
        This glyph is no longer in the face. Choose another glyph in the Studio,
        or redo the revision that added it.
      </Notice>
    );
  }

  const { metrics } = face.description;
  const comparable = editable && source !== undefined;
  const showsBeside = comparable && comparison === "beside";

  return (
    <div className="ty-studio">
      <GlyphTitle
        entry={entry}
        face={face}
        fileName={sourceFont?.fileName ?? ""}
        head={project.head}
        pending={open.pending !== undefined}
        revisionCount={project.revisions.length}
      />
      {editable ? null : (
        <RuledSection
          first
          heading="Pin an instance"
          lede="A variable face can be looked at here, not edited. Choose a location or a named instance and pin it: the pinned instance becomes a face of its own that takes edits."
        >
          <PinPanel
            face={face}
            location={location}
            onLocation={setLocation}
            onPin={pin}
            pinned={pinned}
          />
        </RuledSection>
      )}
      <SplitView
        inspector={
          <GlyphInspector
            canCompare={comparable}
            comparison={comparison}
            editor={editor}
            onComparison={setComparison}
            pending={open.pending?.label}
            project={project}
            shape={shape}
            source={{
              fileName: sourceFont?.fileName ?? "",
              id: face.sourceId,
            }}
            sourceShape={editable ? source : shape}
          />
        }
        inspectorLabel="Measures and revisions"
        inspectorWidth={INSPECTOR_WIDTH}
      >
        <Columns template="232px minmax(0, 1fr)">
          <GlyphChooser
            current={glyph}
            entries={entries}
            face={face}
            faces={project.faces}
            onFace={chooseFace}
            onGlyph={openGlyph}
            shapeOf={shapeOf}
          />
          <div className="ty-studio-work">
            {editor ? (
              <CanvasToolbar
                editor={editor}
                onToolChange={setTool}
                outline={shape.outline}
                selection={open.selection}
                tool={tool}
              />
            ) : null}
            <div className="ty-studio-drawings">
              {showsBeside && source ? (
                <figure className="ty-studio-beside">
                  <GlyphDrawing
                    advance={source.advance}
                    height={SOURCE_HEIGHT}
                    metrics={metrics}
                    outline={source.outline}
                    tone="ink"
                  />
                  <figcaption className="ty-label">Source</figcaption>
                </figure>
              ) : null}
              <GlyphCanvas
                compare={comparable && comparison === "over" ? "over" : "alone"}
                editor={editor}
                key={glyphRefKey(glyph)}
                metrics={metrics}
                name={open.name}
                onPickMeasure={editor ? goToMeasure : undefined}
                onRedo={redo}
                onUndo={undo}
                selection={open.selection}
                shape={shape}
                source={source}
                standing={open.made ? "edited" : "source"}
                tool={tool}
              />
            </div>
          </div>
        </Columns>
      </SplitView>
      <SpecimenSections
        entries={entries}
        entry={entry}
        face={face}
        location={location}
        sourceBytes={sourceFont?.bytes}
        working={open.working}
      />
      <RuledSection
        heading="Candidates"
        lede="Generated and reconstructed designs proposed for this face. Nothing enters the face until it is accepted."
      >
        <CandidatesPanel
          candidates={candidates}
          metrics={metrics}
          onAccept={accept}
          onReject={reject}
          project={project}
        />
      </RuledSection>
      {editable ? (
        <RuledSection
          heading="Next"
          lede="Proof builds this face with every applied change and compares it with its source. Export plans a derived font from it."
        >
          <div className="ty-studio-row">
            <ButtonLink
              href={subjectAddress({ faceId: face.id, kind: "face" })}
            >
              Prove {faceName(face)}
            </ButtonLink>
            <ButtonLink href={exportFaceHash(face.id)}>
              Plan an export
            </ButtonLink>
          </div>
        </RuledSection>
      ) : null}
    </div>
  );
}

interface GlyphWorkbenchProps {
  readonly face: Face;
  readonly project: TypefaceProject;
  /** The glyph the address asked for, if it named one. */
  readonly requested?: GlyphRef;
}

/**
 * Everything for one face in the Studio: choosing a glyph, drawing and
 * editing it, its measures, the history, a specimen set over the working
 * face, how that specimen was shaped, and the candidates waiting for the
 * face. A glyph the address names but the face lacks opens the first letter.
 */
export function GlyphWorkbench({
  face,
  project,
  requested,
}: GlyphWorkbenchProps) {
  const workspace = useWorkspace();
  const entries = workspace.glyphsOf(face.id);
  const entry = useMemo(
    () =>
      (requested && entries.find((known) => sameGlyph(known.ref, requested))) ??
      startingGlyph(entries),
    [entries, requested]
  );
  if (!entry) {
    return (
      <Notice tone="problem">
        This face has no glyphs to open. Choose another face in the Library.
      </Notice>
    );
  }
  return (
    <FaceWorkbench
      entries={entries}
      entry={entry}
      face={face}
      project={project}
    />
  );
}
