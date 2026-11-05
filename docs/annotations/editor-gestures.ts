import type { Anchor, Mark, Point } from "./model.ts";

interface GestureOptions {
  anchorAt: (x: number, y: number) => Anchor;
  complete: (mark: Mark, first: Point, tip: Point) => void;
  enabled: () => boolean;
  makeMark: (kind: Mark["kind"], point: Point) => Mark;
  preview: (mark: Mark | null) => void;
  textAt: (point: Point, client: Point) => void;
  tool: () => string;
}

/** Pointer capture and raw gesture geometry are independent of annotation meaning. */
export function createGestureInput(
  host: HTMLElement,
  surface: SVGElement,
  options: GestureOptions
) {
  let draft: Mark | null = null;
  let activePointer: number | null = null;
  let start: Point | null = null;
  let last: Point | null = null;
  function localPoint(event: PointerEvent): Point {
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function cancel() {
    if (
      activePointer !== null &&
      surface instanceof SVGSVGElement &&
      surface.hasPointerCapture(activePointer)
    ) {
      surface.releasePointerCapture(activePointer);
    }
    activePointer = null;
    draft = null;
    start = null;
    last = null;
    options.preview(null);
  }
  function down(event: PointerEvent) {
    const tool = options.tool();
    if (
      !options.enabled() ||
      event.button !== 0 ||
      activePointer !== null ||
      !["draw", "arrow", "text"].includes(tool)
    ) {
      return;
    }
    const point = localPoint(event);
    if (tool === "text") {
      options.textAt(point, { x: event.clientX, y: event.clientY });
      return;
    }
    event.preventDefault();
    activePointer = event.pointerId;
    start = point;
    last = point;
    draft = options.makeMark(tool === "arrow" ? "arrow" : "draw", point);
    if (surface instanceof SVGSVGElement) {
      surface.setPointerCapture(event.pointerId);
    }
    options.preview(draft);
  }
  function move(event: PointerEvent) {
    if (
      !draft ||
      event.pointerId !== activePointer ||
      !start ||
      draft.points.length >= 2000
    ) {
      return;
    }
    last = localPoint(event);
    if (options.tool() === "arrow") {
      draft.anchor = options.anchorAt(last.x, last.y);
      draft.points = [{ x: start.x - last.x, y: start.y - last.y }];
    } else {
      const previous = draft.points.at(-1);
      const offset = { x: last.x - start.x, y: last.y - start.y };
      if (
        !previous ||
        Math.hypot(offset.x - previous.x, offset.y - previous.y) > 1.5
      ) {
        draft.points.push(offset);
      }
    }
    options.preview(draft);
  }
  function up(event: PointerEvent) {
    if (!draft || event.pointerId !== activePointer || !start || !last) {
      return;
    }
    move(event);
    const mark = draft;
    const first = start;
    const tip = last;
    cancel();
    options.complete(mark, first, tip);
  }
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", cancel);
  return {
    cancel,
    dispose: () => {
      cancel();
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", cancel);
    },
  };
}

export function listenAnnotationKeyboard(
  host: HTMLElement,
  surface: SVGElement,
  options: {
    textActive: () => boolean;
    addText: (point: Point) => void;
    escape: (event: KeyboardEvent) => void;
  }
) {
  function keyDown(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      event.target === surface &&
      options.textActive()
    ) {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      options.addText({
        x: host.clientWidth / 2,
        y: Math.max(0, Math.min(host.clientHeight - 100, 160 - rect.top)),
      });
    }
    if (
      event.key === "Escape" &&
      event.target instanceof Node &&
      host.contains(event.target)
    ) {
      options.escape(event);
    }
  }
  document.addEventListener("keydown", keyDown);
  return () => document.removeEventListener("keydown", keyDown);
}
