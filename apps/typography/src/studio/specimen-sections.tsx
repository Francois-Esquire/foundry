import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { useApplication } from "~/application/react";
import { type GlyphRef, sameGlyph, type WorkingFace } from "~/typeface/changes";
import { type AxisLocation, type Face, isEditable } from "~/typeface/face";
import type { GlyphEntry } from "~/typeface/glyphs";
import { setText } from "~/typeface/typesetting";
import { Notice } from "~/ui/controls/notice";
import { TextField } from "~/ui/controls/text-field";
import { RuledSection } from "~/ui/layout/ruled-section";
import { useWorkspace } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";
import { CompositionPanel } from "./composition-panel";
import {
  type FeatureChoices,
  featureTags,
  withFeature,
} from "./feature-toggles";
import { LayoutSummaryPanel } from "./layout-summary-panel";
import { boxesOf } from "./shaped-boxes";
import { SpecimenLine } from "./specimen-line";
import { specimenTextFor } from "./specimen-text";

const NO_FEATURES: FeatureChoices = {};
const SPECIMEN_SIZE = 72;

interface SpecimenSectionsProps {
  readonly entries: readonly GlyphEntry[];
  /** The glyph being edited: its character leads the starting line. */
  readonly entry: GlyphEntry;
  readonly face: Face;
  /** Where a variable face's axes are set. */
  readonly location: AxisLocation;
  /** The source font file, for the layout summary. */
  readonly sourceBytes: Uint8Array | undefined;
  /** The working face, with any edit under way laid over it. */
  readonly working: WorkingFace;
}

/**
 * The edit in text: a specimen line set over the working face, the same
 * line taken apart into glyph boxes, switches for the face's layout
 * features, and the layout summary from the font engine.
 */
export function SpecimenSections({
  entries,
  entry,
  face,
  location,
  sourceBytes,
  working,
}: SpecimenSectionsProps) {
  const workspace = useWorkspace();
  const builder = useApplication().places.studio;
  const engineStatus = useEngineStatus();
  const [typed, setTyped] = useState<string>();
  const [choices, setChoices] = useState(NO_FEATURES);
  const openFace = workspace.openFace(face.id);
  const text = typed ?? specimenTextFor(openFace, entry.characters);
  const pinnedTo = isEditable(face) ? undefined : location;
  const line = useMemo(
    () =>
      setText(text, openFace, working, {
        features: choices,
        location: pinnedTo,
      }),
    [choices, openFace, pinnedTo, text, working]
  );
  const boxes = useMemo(() => boxesOf(text, line), [line, text]);
  const features = useMemo(
    () => featureTags(face.description.layout),
    [face.description.layout]
  );
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setTyped(event.currentTarget.value),
    []
  );
  const switchFeature = useCallback(
    (tag: string, on: boolean) =>
      setChoices((current) => withFeature(current, tag, on)),
    []
  );
  const nameOf = useCallback(
    (ref: GlyphRef) =>
      entries.find((known) => sameGlyph(known.ref, ref))?.name ?? "",
    [entries]
  );
  const { metrics } = face.description;
  return (
    <>
      <RuledSection
        heading="Specimen"
        lede="A line set over the working face. It follows every edit as it is made, before any font is built."
      >
        <div className="ty-studio-specimen">
          <TextField label="Specimen text" onChange={type} value={text} />
          <SpecimenLine
            line={line}
            metrics={metrics}
            size={SPECIMEN_SIZE}
            working={working}
          />
          {working.featureCode.length > 0 ? (
            <Notice>
              Layout rules added in this project are not applied to this line.
              It is shaped by the source font. Rules added here are proved in a
              built font.
            </Notice>
          ) : null}
        </div>
      </RuledSection>
      <RuledSection
        heading="Composition"
        lede="How the specimen text became glyphs: one box per glyph, grouped by the cluster of characters it came from."
      >
        <CompositionPanel
          boxes={boxes}
          choices={choices}
          faceId={face.id}
          features={features}
          glyphName={nameOf}
          metrics={metrics}
          onFeature={switchFeature}
        />
        {sourceBytes ? (
          <RuledSection
            heading="Layout summary"
            lede="What the face's layout tables hold, read from the source font by the font engine."
            level={3}
          >
            <LayoutSummaryPanel
              builder={builder}
              engineStatus={engineStatus}
              faceIndex={face.index}
              font={sourceBytes}
            />
          </RuledSection>
        ) : null}
      </RuledSection>
    </>
  );
}
