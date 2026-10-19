import {
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
} from "react";
import { createPortal } from "react-dom";
import type { AppBarContext } from "./chrome-entries";
import "./exploration-controls.css";

interface Direction {
  x: number;
  y: number;
}
const stopped = { x: 0, y: 0 };
const directions = [
  { label: "Sail north", symbol: "↑", x: 0, y: -1 },
  { label: "Sail west", symbol: "←", x: -1, y: 0 },
  { label: "Sail south", symbol: "↓", x: 0, y: 1 },
  { label: "Sail east", symbol: "→", x: 1, y: 0 },
] as const;
const keyDirections: Record<string, Direction> = {
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  d: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: 0, y: -1 },
};

function steeringTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !target.matches("input, select, textarea, [contenteditable]") &&
    !!target.closest(".spyglass-map canvas, .spyglass-exploration")
  );
}

/** Keyboard ownership stays with the map and these controls, never the whole page. */
function useSteeringKeys({ actions }: AppBarContext) {
  useEffect(() => {
    if (!actions.exploring) {
      return;
    }
    const held = new Set<string>();
    const move = () => {
      const direction = { x: 0, y: 0 };
      for (const key of held) {
        const value = keyDirections[key];
        if (value) {
          direction.x += value.x;
          direction.y += value.y;
        }
      }
      actions.scene.current?.steer(direction);
    };
    const stop = () => {
      held.clear();
      actions.scene.current?.steer(stopped);
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !steeringTarget(event.target)
      ) {
        return;
      }
      if (document.querySelector("dialog[open]")) {
        stop();
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (!keyDirections[key]) {
        return;
      }
      event.preventDefault();
      held.add(key);
      move();
    };
    const keyup = (event: KeyboardEvent) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (held.delete(key)) {
        move();
      }
    };
    const visibility = () => {
      if (document.hidden) {
        stop();
      }
    };
    const dialogs = new MutationObserver(() => {
      if (document.querySelector("dialog[open]")) {
        stop();
      }
    });
    dialogs.observe(document.body, {
      attributeFilter: ["open"],
      attributes: true,
      subtree: true,
    });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", stop, true);
    window.addEventListener("pointercancel", stop);
    return () => {
      stop();
      dialogs.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", stop, true);
      window.removeEventListener("pointercancel", stop);
    };
  }, [actions.exploring, actions.scene]);
}

function SteeringButton({
  direction,
  steer,
}: {
  direction: (typeof directions)[number];
  steer: (direction: Direction) => void;
}) {
  const stop = useCallback(() => steer(stopped), [steer]);
  const press = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || document.querySelector("dialog[open]")) {
        return;
      }
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      steer(direction);
    },
    [direction, steer]
  );
  const keydown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        (event.key === " " || event.key === "Enter") &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        steer(direction);
      }
    },
    [direction, steer]
  );
  const keyup = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") {
        stop();
      }
    },
    [stop]
  );
  return (
    <button
      aria-label={direction.label}
      onBlur={stop}
      onKeyDown={keydown}
      onKeyUp={keyup}
      onLostPointerCapture={stop}
      onPointerCancel={stop}
      onPointerDown={press}
      onPointerUp={stop}
      title={`${direction.label} (hold)`}
      type="button"
    >
      {direction.symbol}
    </button>
  );
}

export function ExplorationControls(context: AppBarContext) {
  const { actions } = context;
  const instructions = useId();
  useSteeringKeys(context);
  const steer = useCallback(
    (direction: Direction) => actions.scene.current?.steer(direction),
    [actions.scene]
  );
  const follow = useCallback(
    () => actions.scene.current?.followBoat(),
    [actions.scene]
  );
  return (
    <div
      aria-describedby={actions.exploring ? instructions : undefined}
      className="spyglass-exploration"
    >
      <button
        disabled={!actions.sceneReady}
        onClick={
          actions.exploring ? actions.stopExploration : actions.startExploration
        }
        type="button"
      >
        {actions.exploring ? "Return to atlas" : "Explore ocean"}
      </button>
      {actions.exploring && (
        <>
          <fieldset aria-label="Sailboat steering">
            {directions.map((direction) => (
              <SteeringButton
                direction={direction}
                key={direction.label}
                steer={steer}
              />
            ))}
          </fieldset>
          <button onClick={follow} type="button">
            Follow boat
          </button>
          {createPortal(
            <p className="spyglass-exploration-hint" id={instructions}>
              Hold a direction, or focus the map and use WASD / arrow keys.
              Escape returns to your map.
            </p>,
            document.body
          )}
        </>
      )}
      {actions.explorationFailure &&
        createPortal(
          <p className="spyglass-exploration-hint" role="status">
            {actions.explorationFailure}
          </p>,
          document.body
        )}
    </div>
  );
}
