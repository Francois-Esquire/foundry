import { type ChangeEvent, useCallback, useId } from "react";
import type { AppBarContext } from "./chrome-entries";
import "./presentation-control.css";

/** One camera journey, with all geography kept in place. */
export function PresentationControl({ actions, state }: AppBarContext) {
  const id = useId();
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      actions.settings({
        ...state.chartSettings,
        presentation: Number(event.currentTarget.value) / 100,
      });
    },
    [actions.settings, state.chartSettings]
  );
  return (
    <label className="spyglass-presentation" htmlFor={id}>
      <span>Atlas</span>
      <input
        aria-label="Atlas to diorama"
        aria-valuetext={`${Math.round(state.chartSettings.presentation * 55)} degrees from overhead`}
        disabled={!actions.sceneReady}
        id={id}
        max={100}
        min={0}
        onChange={change}
        step={1}
        type="range"
        value={Math.round(state.chartSettings.presentation * 100)}
      />
      <span>Diorama</span>
    </label>
  );
}
