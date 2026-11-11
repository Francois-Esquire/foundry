import { useCallback, useMemo } from "react";
import { formatCodePoint } from "~/lib/code-point";
import { type GlyphRef, glyphRefKey } from "~/typeface/changes";
import type { FaceId, FaceMetrics } from "~/typeface/face";
import { type FeatureChoices, isFeatureOn } from "~/typeface/layout-features";
import { outlineToPath } from "~/typeface/outline";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import type { GlyphBox } from "./shaped-boxes";
import { studioHash } from "./studio-address";

const BOX_SIZE = 56;
const GAP = 8;

interface RunBoxesProps {
  readonly boxes: readonly GlyphBox[];
  readonly metrics: FaceMetrics;
}

/** The shaped run as ruled boxes, one per glyph, with a gap between clusters. */
function RunBoxes({ boxes, metrics }: RunBoxesProps) {
  const scale = BOX_SIZE / metrics.unitsPerEm;
  const height = (metrics.ascender - metrics.descender) * scale;
  let gaps = -1;
  const placed = boxes.map((box) => {
    gaps += box.clusterStart ? 1 : 0;
    return { box, left: box.x * scale + gaps * GAP };
  });
  const last = placed.at(-1);
  const width = last ? last.left + last.box.advance * scale + 1 : 1;
  return (
    <ScrollRegion axis="x" label="Shaped run">
      <svg
        aria-hidden="true"
        className="ty-studio-run"
        height={height + 1}
        width={width}
      >
        {placed.map(({ box, left }, index) => (
          <g key={index} transform={`translate(${Math.round(left) + 0.5} 0.5)`}>
            <rect height={height} width={Math.max(1, box.advance * scale)} />
            <path
              d={outlineToPath(box.outline)}
              transform={`translate(${box.xOffset * scale} ${(metrics.ascender - box.yOffset) * scale}) scale(${scale} ${-scale})`}
            />
          </g>
        ))}
      </svg>
    </ScrollRegion>
  );
}

interface BoxRow {
  readonly box: GlyphBox;
  readonly index: number;
}

const boxKey = ({ box, index }: BoxRow) => `${index} ${glyphRefKey(box.ref)}`;

const charactersOf = (text: string) =>
  [...text]
    .map((character) => formatCodePoint(character.codePointAt(0) ?? 0))
    .join(" ");

interface CompositionPanelProps {
  readonly boxes: readonly GlyphBox[];
  readonly choices: FeatureChoices;
  readonly faceId: FaceId;
  /** Every layout feature the face has. */
  readonly features: readonly string[];
  readonly glyphName: (ref: GlyphRef) => string;
  readonly metrics: FaceMetrics;
  readonly onFeature: (tag: string, on: boolean) => void;
}

interface FeatureSwitchProps {
  readonly on: boolean;
  readonly onFeature: (tag: string, on: boolean) => void;
  readonly tag: string;
}

function FeatureSwitch({ on, onFeature, tag }: FeatureSwitchProps) {
  const change = useCallback(
    (pressed: boolean) => onFeature(tag, pressed),
    [onFeature, tag]
  );
  return (
    <ToggleButton onPressedChange={change} pressed={on}>
      {tag}
    </ToggleButton>
  );
}

/**
 * How the specimen text was shaped: each glyph in a box with its cluster and
 * advance, and a switch for every layout feature the face has.
 */
export function CompositionPanel({
  boxes,
  choices,
  faceId,
  features,
  glyphName,
  metrics,
  onFeature,
}: CompositionPanelProps) {
  const columns = useMemo(
    (): DataColumn<BoxRow>[] => [
      {
        cell: ({ index }) => index + 1,
        header: "Box",
        id: "box",
        kind: "label",
      },
      {
        cell: ({ box }) =>
          box.missing ? (
            "No glyph for this character"
          ) : (
            <a href={studioHash(faceId, box.ref)}>{glyphName(box.ref)}</a>
          ),
        header: "Glyph",
        id: "glyph",
        kind: "text",
      },
      {
        cell: ({ box }) => box.clusterNumber,
        header: "Cluster",
        id: "cluster",
        kind: "numeric",
      },
      {
        cell: ({ box }) => charactersOf(box.text),
        header: "Characters",
        id: "characters",
        kind: "text",
      },
      {
        cell: ({ box }) => box.advance,
        header: "Advance",
        id: "advance",
        kind: "numeric",
      },
      {
        cell: ({ box }) =>
          box.xOffset === 0 && box.yOffset === 0
            ? ""
            : `${box.xOffset}, ${box.yOffset}`,
        header: "Offset",
        id: "offset",
        kind: "numeric",
      },
    ],
    [faceId, glyphName]
  );
  const rows = useMemo(
    () => boxes.map((box, index): BoxRow => ({ box, index })),
    [boxes]
  );
  return (
    <div className="ty-studio-composition">
      {boxes.length === 0 ? (
        <p className="ty-lede">
          Type some specimen text above to see how it is shaped.
        </p>
      ) : (
        <>
          <RunBoxes boxes={boxes} metrics={metrics} />
          <DataTable
            caption="The shaped run, one row per glyph box"
            columns={columns}
            rowKey={boxKey}
            rows={rows}
          />
        </>
      )}
      {features.length === 0 ? (
        <p className="ty-lede">This face has no layout features.</p>
      ) : (
        <fieldset className="ty-studio-features">
          <legend className="ty-label">Layout features</legend>
          <div className="ty-studio-row">
            {features.map((tag) => (
              <FeatureSwitch
                key={tag}
                on={isFeatureOn(choices, tag)}
                onFeature={onFeature}
                tag={tag}
              />
            ))}
          </div>
          <p className="ty-lede">
            A filled box is a feature that applies to the specimen. Features
            start the way a shaper applies them and switch for this specimen
            only.
          </p>
        </fieldset>
      )}
    </div>
  );
}
