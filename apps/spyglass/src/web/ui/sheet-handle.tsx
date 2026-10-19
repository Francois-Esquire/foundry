import { type MouseEvent, type PointerEvent, useCallback, useRef } from "react";

/** A real drag target; activating it with a click or keyboard also closes the sheet. */
export function SheetHandle({ onClose }: { onClose: () => void }) {
  const drag = useRef<{ id: number; y: number; distance: number } | null>(null);
  const dragged = useRef(false);
  const start = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }
    dragged.current = false;
    drag.current = { distance: 0, id: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const move = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const { current } = drag;
    if (current === null || current.id !== event.pointerId) {
      return;
    }
    current.distance = Math.max(0, event.clientY - current.y);
    dragged.current ||= Math.abs(event.clientY - current.y) > 5;
    const sheet = event.currentTarget.closest("dialog");
    sheet?.style.setProperty("translate", `0 ${current.distance}px`);
  }, []);
  const finish = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const { current } = drag;
      if (current === null || current.id !== event.pointerId) {
        return;
      }
      drag.current = null;
      const sheet = event.currentTarget.closest("dialog");
      sheet?.style.removeProperty("translate");
      if (
        event.type === "pointerup" &&
        current.distance >=
          Math.max(64, Math.min(120, (sheet?.clientHeight ?? 0) / 4))
      ) {
        onClose();
      }
    },
    [onClose]
  );
  const click = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0 || !dragged.current) {
        onClose();
      }
      dragged.current = false;
    },
    [onClose]
  );
  return (
    <button
      aria-label="Close sheet; drag down to dismiss"
      className="spyglass-sheet-handle"
      onClick={click}
      onLostPointerCapture={finish}
      onPointerCancel={finish}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      type="button"
    >
      <span />
    </button>
  );
}
