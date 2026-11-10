import "./slider.css";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import {
  fractionOf,
  parseReadout,
  snapToStep,
  valueAfterKey,
} from "./slider-value";

interface SliderStop {
  readonly name: string;
  readonly value: number;
}

interface SliderProps {
  readonly disabled?: boolean;
  /** Formats the readout. Defaults to the plain number. */
  readonly format?: (value: number) => string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  /** Named positions on the axis, such as Regular at 400. */
  readonly stops?: readonly SliderStop[];
  readonly value: number;
}

const plain = (value: number) => String(value);

/**
 * An axis slider: a hairline track, a hollow thumb, a readout that can be
 * typed into, and named stops. Arrow keys move one step, Shift with an arrow
 * or Page Up and Page Down move ten, Home and End go to the ends.
 */
export function Slider({
  disabled,
  format = plain,
  label,
  max,
  min,
  onChange,
  step = 1,
  stops = [],
  value,
}: SliderProps) {
  const id = useId();
  const range = useMemo(() => ({ max, min, step }), [max, min, step]);
  const [draft, setDraft] = useState<string>();
  const stopHere = stops.find((stop) => stop.value === value);

  const change = useCallback(
    (next: number) => {
      const snapped = snapToStep(next, range);
      if (snapped !== value) {
        onChange(snapped);
      }
    },
    [onChange, range, value]
  );

  const drag = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      change(Number(event.currentTarget.value)),
    [change]
  );

  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const next = valueAfterKey(value, event.key, range, event.shiftKey);
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      change(next);
    },
    [change, range, value]
  );

  const typeDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setDraft(event.currentTarget.value),
    []
  );

  const commitDraft = useCallback(() => {
    const typed = draft === undefined ? undefined : parseReadout(draft);
    if (typed !== undefined) {
      change(typed);
    }
    setDraft(undefined);
  }, [change, draft]);

  const pressReadoutKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commitDraft();
      } else if (event.key === "Escape") {
        setDraft(undefined);
      }
    },
    [commitDraft]
  );

  const goToStop = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      change(Number(event.currentTarget.value)),
    [change]
  );

  return (
    <div className="ty-slider" data-disabled={disabled}>
      <label className="ty-label ty-slider-label" htmlFor={id}>
        {label}
      </label>
      <div className="ty-slider-track">
        {stops.map((stop) => (
          <span
            className="ty-slider-tick"
            key={stop.value}
            style={{
              left: `calc(4px + (100% - 9px) * ${fractionOf(stop.value, range)})`,
            }}
          />
        ))}
        <input
          aria-valuetext={
            stopHere ? `${format(value)}, ${stopHere.name}` : format(value)
          }
          className="ty-slider-range"
          disabled={disabled}
          id={id}
          max={max}
          min={min}
          onChange={drag}
          onKeyDown={pressKey}
          step={step}
          type="range"
          value={value}
        />
      </div>
      <input
        aria-label={`${label} value`}
        className="ty-slider-readout"
        disabled={disabled}
        inputMode="decimal"
        onBlur={commitDraft}
        onChange={typeDraft}
        onKeyDown={pressReadoutKey}
        type="text"
        value={draft ?? format(value)}
      />
      {stops.length > 0 ? (
        <ul aria-label={`${label} stops`} className="ty-slider-stops">
          {stops.map((stop) => (
            <li key={stop.value}>
              <button
                aria-pressed={stop.value === value}
                className="ty-label ty-slider-stop"
                disabled={disabled}
                onClick={goToStop}
                type="button"
                value={stop.value}
              >
                {stop.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
