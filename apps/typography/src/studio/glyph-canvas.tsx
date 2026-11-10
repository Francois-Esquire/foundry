import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FaceMetrics } from "~/typeface/face";
import { outlineToPath, type Point } from "~/typeface/outline";
import type { PointAddress } from "~/typeface/outline-editing";
import type { GlyphShape } from "~/typeface/reading";
import { Button } from "~/ui/controls/button";
import { type Measure, measureOf } from "./bearings";
import { drawingBox, hitAt, outlinePlaceAt } from "./canvas-hits";
import { type CanvasCommand, commandForKey, ZOOM_STEP } from "./canvas-keys";
import {
  Callouts,
  MetricLines,
  PointMarks,
  SpacingLines,
} from "./canvas-layers";
import type { GlyphEditor } from "./glyph-editor";
import {
  EMPTY_SELECTION,
  isSelected,
  pointsInBox,
  type Selection,
  selectAll,
  selectedTogether,
  stepSelection,
  toggleSelected,
} from "./selection";
import {
  type FrameSize,
  fitView,
  panBy,
  svgTransform,
  toFont,
  type ViewTransform,
  zoomAt,
} from "./view-transform";

export type CanvasTool = "pan" | "select";

/** Over: the edit as a line over the source in ink. Alone: the edit filled, as it will print. */
type CompareMode = "alone" | "over";

/** Whether the glyph is as the source font has it, or made after it. */
type GlyphStanding = "edited" | "source";

interface LineGesture {
  readonly at: Point;
  /** The measure's value when the drag began. */
  readonly from: number;
  readonly kind: "line";
  readonly measure: "advance" | "left";
  readonly view: ViewTransform;
}

type Gesture =
  | { readonly kind: "box"; readonly at: Point; readonly kept: Selection }
  | { readonly kind: "pan"; readonly at: Point; readonly view: ViewTransform }
  | { readonly kind: "points"; readonly at: Point }
  | LineGesture;

interface GlyphCanvasProps {
  readonly compare: CompareMode;
  /** Left out for a glyph that can be looked at but not edited. */
  readonly editor?: GlyphEditor;
  readonly metrics: FaceMetrics;
  /** The glyph's name, for the drawing's spoken label. */
  readonly name: string;
  readonly onPickMeasure?: (measure: Measure) => void;
  readonly onRedo: () => void;
  readonly onUndo: () => void;
  readonly selection: Selection;
  readonly shape: GlyphShape;
  /** The glyph in the source font. Absent for a glyph the project added. */
  readonly source?: GlyphShape;
  readonly standing: GlyphStanding;
  readonly tool: CanvasTool;
}

const MARGIN = 40;
/** How fast a pinch or Ctrl with the wheel zooms. */
const WHEEL_ZOOM = 0.01;
const NO_FRAME: FrameSize = { height: 0, width: 0 };

const positionIn = (
  element: Element,
  event: { readonly clientX: number; readonly clientY: number }
): Point => {
  const frame = element.getBoundingClientRect();
  return { x: event.clientX - frame.left, y: event.clientY - frame.top };
};

/**
 * Selects on a press the way a click would, before a drag begins. Returns
 * false when the press only took a point out of the selection.
 */
const selectForDrag = (
  editor: GlyphEditor,
  selection: Selection,
  address: PointAddress,
  additive: boolean
) => {
  const wasSelected = isSelected(selection, address);
  if (additive) {
    editor.select(toggleSelected(selection, address));
    return !wasSelected;
  }
  if (!wasSelected) {
    editor.select([address]);
  }
  return true;
};

/**
 * Drags the advance or the origin line and returns the view to show. The
 * advance line moves across a still drawing. Dragging the origin right
 * closes the gap before the outline, and the view moves with it, so the line
 * follows the pointer while the outline stays where it is on screen.
 */
const dragLine = (
  editor: GlyphEditor,
  gesture: LineGesture,
  dx: number
): ViewTransform => {
  const { from, measure, view } = gesture;
  const units = Math.round(dx / view.scale);
  if (measure === "advance") {
    editor.dragMeasure("advance", from + units);
    return view;
  }
  editor.dragMeasure("left", from - units);
  const shown = editor.shape();
  const reached = (shown && measureOf(shown, "left")) ?? from;
  return panBy(view, (from - reached) * view.scale, 0);
};

/**
 * The glyph drawn large: metric lines, the source in ink, the edit as a
 * carbon line with its nodes and handles, and lettered callouts keyed to the
 * measure table. Points are selected, dragged and nudged here; the origin
 * and advance lines can be dragged too.
 */
export function GlyphCanvas({
  compare,
  editor,
  metrics,
  name,
  onPickMeasure,
  onRedo,
  onUndo,
  selection,
  shape,
  source,
  standing,
  tool,
}: GlyphCanvasProps) {
  const hintId = useId();
  const [frame, setFrame] = useState(NO_FRAME);
  // The box the fitted view shows. It only follows the glyph when asked, so
  // the drawing does not slide about while the advance is being dragged.
  const [fitted, setFitted] = useState(() => drawingBox(metrics, shape));
  const [chosenView, setChosenView] = useState<ViewTransform>();
  const [box, setBox] = useState<{
    readonly from: Point;
    readonly to: Point;
  }>();
  const gesture = useRef<Gesture | undefined>(undefined);
  const view = useMemo(
    () => chosenView ?? fitView(frame, fitted, MARGIN),
    [chosenView, fitted, frame]
  );
  const latestView = useRef(view);
  useEffect(() => {
    latestView.current = view;
  }, [view]);

  const follow = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return;
    }
    const measure = () =>
      setFrame({ height: element.clientHeight, width: element.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // React listens to the wheel passively, so zooming could not stop the page from scrolling.
    const zoom = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      setChosenView(
        zoomAt(
          latestView.current,
          positionIn(element, event),
          Math.exp(-event.deltaY * WHEEL_ZOOM)
        )
      );
    };
    element.addEventListener("wheel", zoom, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", zoom);
    };
  }, []);

  const zoomBy = useCallback(
    (factor: number) =>
      setChosenView(
        zoomAt(view, { x: frame.width / 2, y: frame.height / 2 }, factor)
      ),
    [frame, view]
  );
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const fit = useCallback(() => {
    setFitted(drawingBox(metrics, shape));
    setChosenView(undefined);
  }, [metrics, shape]);

  const press = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (event.button > 1) {
        return;
      }
      const at = positionIn(event.currentTarget, event);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!editor || tool === "pan" || event.button === 1) {
        gesture.current = { at, kind: "pan", view };
        return;
      }
      const hit = hitAt(view, shape, at);
      if (hit.kind === "point") {
        if (selectForDrag(editor, selection, hit.address, event.shiftKey)) {
          editor.beginDrag();
          gesture.current = { at, kind: "points" };
        }
        return;
      }
      if (hit.kind === "line") {
        editor.beginDrag();
        gesture.current = {
          at,
          from: measureOf(shape, hit.measure) ?? 0,
          kind: "line",
          measure: hit.measure,
          view,
        };
        return;
      }
      gesture.current = {
        at,
        kept: event.shiftKey ? selection : EMPTY_SELECTION,
        kind: "box",
      };
      setBox({ from: at, to: at });
    },
    [editor, selection, shape, tool, view]
  );

  const drag = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const { current } = gesture;
      if (current === undefined) {
        return;
      }
      const at = positionIn(event.currentTarget, event);
      const dx = at.x - current.at.x;
      const dy = at.y - current.at.y;
      if (current.kind === "pan") {
        setChosenView(panBy(current.view, dx, dy));
      } else if (current.kind === "box") {
        setBox({ from: current.at, to: at });
      } else if (current.kind === "points") {
        editor?.dragPoints(dx / view.scale, -dy / view.scale);
      } else if (editor) {
        setChosenView(dragLine(editor, current, dx));
      }
    },
    [editor, view]
  );

  const release = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const { current } = gesture;
      gesture.current = undefined;
      if (current?.kind === "box") {
        const at = positionIn(event.currentTarget, event);
        const inside = pointsInBox(
          shape.outline,
          toFont(view, current.at),
          toFont(view, at)
        );
        editor?.select(selectedTogether(current.kept, inside));
        setBox(undefined);
      } else if (current?.kind === "points" || current?.kind === "line") {
        editor?.endDrag();
      }
    },
    [editor, shape, view]
  );

  const addNodeAt = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      const at = positionIn(event.currentTarget, event);
      if (!editor || hitAt(view, shape, at).kind === "point") {
        return;
      }
      const place = outlinePlaceAt(view, shape, at);
      if (place) {
        editor.addNode(place);
      }
    },
    [editor, shape, view]
  );

  const run = useCallback(
    (command: CanvasCommand) => {
      switch (command.kind) {
        case "pan":
          setChosenView(panBy(view, command.dx, command.dy));
          break;
        case "zoom":
          zoomBy(command.factor);
          break;
        case "fit":
          fit();
          break;
        case "nudge":
          editor?.nudge(command.dx, command.dy);
          break;
        case "step":
          editor?.select(
            stepSelection(
              shape.outline,
              selection,
              command.direction,
              command.extend
            )
          );
          break;
        case "select-all":
          editor?.select(selectAll(shape.outline));
          break;
        case "clear":
          editor?.select(EMPTY_SELECTION);
          break;
        case "delete":
          editor?.deleteSelected();
          break;
        case "undo":
          onUndo();
          break;
        default:
          onRedo();
      }
    },
    [editor, fit, onRedo, onUndo, selection, shape, view, zoomBy]
  );

  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const command = commandForKey(event);
      if (command) {
        // Without this the arrow keys would also scroll the screen.
        event.preventDefault();
        run(command);
      }
    },
    [run]
  );

  // A run of nudges ends when attention leaves the drawing.
  const leave = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        editor?.flush();
      }
    },
    [editor]
  );

  const path = useMemo(() => outlineToPath(shape.outline), [shape.outline]);
  const sourcePath = useMemo(
    () => (source ? outlineToPath(source.outline) : undefined),
    [source]
  );
  const showsSource =
    compare === "over" && standing !== "source" && sourcePath !== undefined;
  const filled = compare === "alone" || standing === "source";

  return (
    <div className="ty-studio-canvas">
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the drawing is one keyboard-operated editor, with its keys listed in the hint below. */}
      <div
        aria-describedby={hintId}
        aria-label={`Outline of ${name}`}
        className="ty-studio-canvas-frame"
        data-tool={editor ? tool : "pan"}
        onBlur={leave}
        onKeyDown={pressKey}
        ref={follow}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the editor is a single stop for Tab, and takes its keys from there.
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          data-standing={standing}
          height={frame.height}
          onDoubleClick={addNodeAt}
          onPointerCancel={release}
          onPointerDown={press}
          onPointerMove={drag}
          onPointerUp={release}
          width={frame.width}
        >
          <MetricLines frame={frame} metrics={metrics} view={view} />
          <SpacingLines
            editable={editor !== undefined}
            frame={frame}
            shape={shape}
            view={view}
          />
          <g transform={svgTransform(view)}>
            {showsSource ? (
              <path className="ty-studio-source" d={sourcePath} />
            ) : null}
            <path className="ty-studio-edit" d={path} data-filled={filled} />
          </g>
          <Callouts onPick={onPickMeasure} shape={shape} view={view} />
          <PointMarks
            outline={shape.outline}
            selection={selection}
            view={view}
          />
          {box ? (
            <rect
              className="ty-studio-box"
              height={Math.abs(box.to.y - box.from.y)}
              width={Math.abs(box.to.x - box.from.x)}
              x={Math.min(box.from.x, box.to.x)}
              y={Math.min(box.from.y, box.to.y)}
            />
          ) : null}
        </svg>
      </div>
      <div className="ty-studio-canvas-foot">
        <p id={hintId}>
          {editor
            ? "Click a point to select it, Shift-click to add to the selection, or drag across several. Drag points and the dotted lines. Arrow keys move the selection one unit, ten with Shift. Page Down and Page Up step through the points. Double-click the outline to add a node."
            : "Drag to move the drawing. Alt with the arrow keys moves it from the keyboard."}{" "}
          Plus and minus zoom, and so does Ctrl with the wheel. Zero fits the
          glyph.
        </p>
        <div className="ty-studio-row">
          <Button onClick={zoomOut} symbol="remove">
            Zoom out
          </Button>
          <Button onClick={zoomIn} symbol="add">
            Zoom in
          </Button>
          <Button onClick={fit}>Fit</Button>
        </div>
      </div>
    </div>
  );
}
