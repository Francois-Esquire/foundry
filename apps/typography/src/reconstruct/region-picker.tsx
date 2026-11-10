import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useState,
} from "react";
import type { Point } from "~/typeface/outline";
import { type EvidenceRegion, regionCorners } from "./core";
import { EvidencePicture, OverlayLine, polygonPath } from "./evidence-picture";
import {
  clampPoint,
  quadrilateralThrough,
  rectangleBetween,
} from "./region-geometry";
import type { Photograph } from "./use-session";

export type MarkingMode = "corners" | "rectangle";

interface RegionPickerProps {
  readonly disabled: boolean;
  readonly mode: MarkingMode;
  /** Called with a new region, or with the reason four corners did not make one. */
  readonly onMark: (region: EvidenceRegion | undefined) => void;
  readonly photograph: Photograph;
  readonly region: EvidenceRegion | undefined;
}

/** A handle is this share of the picture's width, so it reads at any size. */
const HANDLE = 0.006;

const cornerPath = ({ x, y }: Point, size: number) =>
  `M${x - size} ${y - size}H${x + size}V${y + size}H${x - size}Z`;

/**
 * The photograph as a surface to mark: drag a rectangle over the lettering,
 * or place four corners around it. The number fields beside it do the same
 * from the keyboard.
 */
export function RegionPicker({
  disabled,
  mode,
  onMark,
  photograph,
  region,
}: RegionPickerProps) {
  const { evidence } = photograph;
  const [drag, setDrag] = useState<{ from: Point; to: Point }>();
  const [placed, setPlaced] = useState<readonly Point[]>([]);
  const handle = evidence.width * HANDLE;

  const pointAt = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): Point => {
      const frame = event.currentTarget.getBoundingClientRect();
      return clampPoint(
        {
          x: ((event.clientX - frame.left) / frame.width) * evidence.width,
          y: ((event.clientY - frame.top) / frame.height) * evidence.height,
        },
        evidence
      );
    },
    [evidence]
  );

  const press = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (disabled || event.button !== 0) {
        return;
      }
      const point = pointAt(event);
      if (mode === "rectangle") {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ from: point, to: point });
        return;
      }
      const next = [...placed, point];
      if (next.length < 4) {
        setPlaced(next);
        return;
      }
      setPlaced([]);
      onMark(quadrilateralThrough(next, evidence));
    },
    [disabled, evidence, mode, onMark, placed, pointAt]
  );

  const move = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (drag) {
        setDrag({ from: drag.from, to: pointAt(event) });
      }
    },
    [drag, pointAt]
  );

  const release = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!drag) {
        return;
      }
      setDrag(undefined);
      const marked = rectangleBetween(drag.from, pointAt(event), evidence);
      if (marked) {
        onMark(marked);
      }
    },
    [drag, evidence, onMark, pointAt]
  );

  const cancel = useCallback(() => setDrag(undefined), []);

  const dragged = drag && rectangleBetween(drag.from, drag.to, evidence);
  const shown = dragged ?? (placed.length > 0 ? undefined : region);
  const corners = shown ? regionCorners(shown) : placed;
  return (
    <EvidencePicture
      className="ty-reconstruct-marking"
      data-disabled={disabled}
      label={`${evidence.fileName}. ${
        mode === "rectangle"
          ? "Drag a rectangle over the lettering"
          : "Place four corners around the lettering"
      }, or use the number fields.`}
      onPointerCancel={cancel}
      onPointerDown={press}
      onPointerMove={move}
      onPointerUp={release}
      photograph={photograph}
    >
      {shown ? <OverlayLine d={polygonPath(regionCorners(shown))} /> : null}
      {mode === "corners" || shown?.kind === "quadrilateral"
        ? corners.map((corner) => (
            <OverlayLine
              d={cornerPath(corner, handle)}
              key={`${corner.x},${corner.y}`}
            />
          ))
        : null}
    </EvidencePicture>
  );
}
