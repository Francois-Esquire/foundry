/** The still parts of the glyph drawing, each drawn at screen coordinates so strokes stay one pixel. */
import { useCallback } from "react";
import type { FaceMetrics } from "~/typeface/face";
import type { Outline } from "~/typeface/outline";
import { addressKey, editablePoints } from "~/typeface/outline-editing";
import type { GlyphShape } from "~/typeface/reading";
import { bearingsOf, type Measure } from "./bearings";
import { isSelected, type Selection } from "./selection";
import { type FrameSize, toScreen, type ViewTransform } from "./view-transform";

/** Lands a one-pixel stroke on whole pixels. */
const crisp = (value: number) => Math.round(value) + 0.5;

const metricLines = (metrics: FaceMetrics) =>
  [
    { name: "Ascender", value: metrics.ascender },
    { name: "Cap height", value: metrics.capHeight },
    { name: "x-height", value: metrics.xHeight },
    { name: "Baseline", value: 0 },
    { name: "Descender", value: metrics.descender },
  ].flatMap(({ name, value }) =>
    value === undefined ? [] : [{ name, value }]
  );

interface MetricLinesProps {
  readonly frame: FrameSize;
  readonly metrics: FaceMetrics;
  readonly view: ViewTransform;
}

/** The face's vertical metrics as ruled lines, named on the left and measured on the right. */
export function MetricLines({ frame, metrics, view }: MetricLinesProps) {
  return (
    <g className="ty-studio-metrics">
      {metricLines(metrics).map(({ name, value }) => {
        const y = crisp(toScreen(view, { x: 0, y: value }).y);
        return (
          <g key={name}>
            <line
              className={value === 0 ? "ty-studio-baseline" : undefined}
              x1={0}
              x2={frame.width}
              y1={y}
              y2={y}
            />
            <text x={0} y={y - 5}>
              {name}
            </text>
            <text textAnchor="end" x={frame.width} y={y - 5}>
              {value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

interface SpacingLinesProps {
  /** Shows the lines as things to drag. */
  readonly editable: boolean;
  readonly frame: FrameSize;
  readonly shape: GlyphShape;
  readonly view: ViewTransform;
}

/** The origin and the advance: the two dotted verticals the glyph sits between. */
export function SpacingLines({
  editable,
  frame,
  shape,
  view,
}: SpacingLinesProps) {
  const origin = crisp(toScreen(view, { x: 0, y: 0 }).x);
  const advance = crisp(toScreen(view, { x: shape.advance, y: 0 }).x);
  const drawn = shape.outline.contours.length > 0;
  return (
    <g className="ty-studio-spacing">
      <line x1={origin} x2={origin} y1={0} y2={frame.height} />
      <line x1={advance} x2={advance} y1={0} y2={frame.height} />
      {editable && drawn ? (
        <line
          className="ty-studio-grip"
          x1={origin}
          x2={origin}
          y1={0}
          y2={frame.height}
        />
      ) : null}
      {editable ? (
        <line
          className="ty-studio-grip"
          x1={advance}
          x2={advance}
          y1={0}
          y2={frame.height}
        />
      ) : null}
    </g>
  );
}

const CALLOUT_RADIUS = 9;
const BEARING_DROP = 24;
const ADVANCE_DROP = 52;
const TICK = 5;

interface CalloutProps {
  readonly letter: "A" | "B" | "C";
  readonly measure: Measure;
  readonly onPick?: (measure: Measure) => void;
  readonly x: number;
  readonly y: number;
}

function Callout({ letter, measure, onPick, x, y }: CalloutProps) {
  const pick = useCallback(() => onPick?.(measure), [measure, onPick]);
  return (
    <g className="ty-studio-callout" onPointerDown={pick}>
      <circle cx={x} cy={y} r={CALLOUT_RADIUS} />
      <text textAnchor="middle" x={x} y={y + 3.5}>
        {letter}
      </text>
    </g>
  );
}

interface DimensionProps {
  readonly from: number;
  readonly to: number;
  readonly y: number;
}

/** A dimension line with a tick at each end. */
function Dimension({ from, to, y }: DimensionProps) {
  return (
    <path
      d={`M${from} ${y - TICK}V${y + TICK}M${from} ${y}H${to}M${to} ${y - TICK}V${y + TICK}`}
    />
  );
}

interface CalloutsProps {
  /** Called when a callout is pressed, to take the person to its number. */
  readonly onPick?: (measure: Measure) => void;
  readonly shape: GlyphShape;
  readonly view: ViewTransform;
}

/**
 * Lettered dimension lines under the baseline. Each letter keys a line on
 * the drawing to its row in the measure table.
 */
export function Callouts({ onPick, shape, view }: CalloutsProps) {
  const baseline = toScreen(view, { x: 0, y: 0 });
  const origin = crisp(baseline.x);
  const advance = crisp(toScreen(view, { x: shape.advance, y: 0 }).x);
  const bearings = bearingsOf(shape);
  const bearingY = crisp(baseline.y + BEARING_DROP);
  const advanceY = crisp(baseline.y + ADVANCE_DROP);
  const left = bearings && crisp(toScreen(view, { x: bearings.left, y: 0 }).x);
  const right =
    bearings &&
    crisp(toScreen(view, { x: shape.advance - bearings.right, y: 0 }).x);
  return (
    <g className="ty-studio-callouts">
      <Dimension from={origin} to={advance} y={advanceY} />
      <Callout
        letter="A"
        measure="advance"
        onPick={onPick}
        x={(origin + advance) / 2}
        y={advanceY}
      />
      {left === undefined || right === undefined ? null : (
        <>
          <Dimension from={origin} to={left} y={bearingY} />
          <Callout
            letter="B"
            measure="left"
            onPick={onPick}
            x={Math.min(origin, left) - CALLOUT_RADIUS - 8}
            y={bearingY}
          />
          <Dimension from={right} to={advance} y={bearingY} />
          <Callout
            letter="C"
            measure="right"
            onPick={onPick}
            x={Math.max(advance, right) + CALLOUT_RADIUS + 8}
            y={bearingY}
          />
        </>
      )}
    </g>
  );
}

const NODE_SIZE = 7;
const HANDLE_RADIUS = 3;

interface PointMarksProps {
  readonly outline: Outline;
  readonly selection: Selection;
  readonly view: ViewTransform;
}

/** Nodes as squares, handles as circles on an arm from their node. Selected points are filled. */
export function PointMarks({ outline, selection, view }: PointMarksProps) {
  const points = editablePoints(outline).map((point) => ({
    anchor: point.anchor && toScreen(view, point.anchor),
    at: toScreen(view, point.point),
    key: addressKey(point.address),
    node: point.address.kind === "node",
    selected: isSelected(selection, point.address),
  }));
  return (
    <g className="ty-studio-points">
      {points.map(({ anchor, at, key }) =>
        anchor ? (
          <line
            key={`arm ${key}`}
            x1={anchor.x}
            x2={at.x}
            y1={anchor.y}
            y2={at.y}
          />
        ) : null
      )}
      {points.map(({ at, key, node, selected }) =>
        node ? (
          <rect
            data-selected={selected}
            height={NODE_SIZE}
            key={key}
            width={NODE_SIZE}
            x={crisp(at.x) - NODE_SIZE / 2}
            y={crisp(at.y) - NODE_SIZE / 2}
          />
        ) : (
          <circle
            cx={at.x}
            cy={at.y}
            data-selected={selected}
            key={key}
            r={HANDLE_RADIUS}
          />
        )
      )}
    </g>
  );
}
