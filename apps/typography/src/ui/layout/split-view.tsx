import "./layout.css";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

const KEY_STEP = 16;
const noop = () => undefined;

interface SplitViewProps {
  /** The work area. */
  readonly children: ReactNode;
  /** Fills the height of its parent and lets each side scroll on its own. */
  readonly fill?: boolean;
  readonly inspector: ReactNode;
  readonly inspectorLabel: string;
  /** Starting width of the inspector in pixels. */
  readonly inspectorWidth?: number;
  /** Width limits in pixels. Setting them makes the inspector resizable. */
  readonly resize?: { readonly max: number; readonly min: number };
}

/**
 * A work area with an inspector column on the right. With resize limits the
 * rule between them can be dragged, or moved with the arrow keys, Home and
 * End. Below 720 pixels the inspector moves under the work area.
 */
export function SplitView({
  children,
  fill = false,
  inspector,
  inspectorLabel,
  inspectorWidth = 320,
  resize,
}: SplitViewProps) {
  const [width, setWidth] = useState(inspectorWidth);
  const dragStart = useRef({ width: 0, x: 0 });
  const min = resize?.min ?? inspectorWidth;
  const max = resize?.max ?? inspectorWidth;

  const resizeTo = useCallback(
    (next: number) => setWidth(Math.min(max, Math.max(min, Math.round(next)))),
    [max, min]
  );

  const startDrag = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      // The native range drag would map the pointer onto nine pixels. Capture
      // ends by itself when the pointer lifts, and with it the drag.
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = { width, x: event.clientX };
    },
    [width]
  );

  const drag = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      const start = dragStart.current;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        resizeTo(start.width + start.x - event.clientX);
      }
    },
    [resizeTo]
  );

  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // The rule moves with the arrow, so left makes the inspector wider.
      const targets: Readonly<Record<string, number>> = {
        ArrowLeft: width + KEY_STEP,
        ArrowRight: width - KEY_STEP,
        End: max,
        Home: min,
      };
      const target = targets[event.key];
      if (target !== undefined) {
        event.preventDefault();
        resizeTo(target);
      }
    },
    [max, min, resizeTo, width]
  );

  return (
    <div className="ty-split-frame" data-fill={fill}>
      <div
        className="ty-split"
        style={{ "--ty-inspector": `${width}px` } as CSSProperties}
      >
        <div className="ty-split-main">{children}</div>
        <aside aria-label={inspectorLabel} className="ty-split-inspector">
          {resize ? (
            <>
              <input
                aria-label={`${inspectorLabel} width`}
                className="ty-split-resizer"
                max={max}
                min={min}
                onChange={noop}
                onKeyDown={pressKey}
                onPointerDown={startDrag}
                onPointerMove={drag}
                type="range"
                value={width}
              />
              <span aria-hidden="true" className="ty-split-grip" />
            </>
          ) : null}
          {inspector}
        </aside>
      </div>
    </div>
  );
}
