import "./settings-controls.css";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Native inputs keep their hit targets aligned with the visible control. */
export function SettingsRange<Key extends string>({
  name,
  label,
  value,
  min,
  max,
  step,
  unit = "",
  disabled = false,
  commitOnRelease = false,
  onChange,
}: {
  name: Key;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  commitOnRelease?: boolean;
  onChange: (key: Key, value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    setDraft(value);
    committed.current = value;
  }, [value]);
  const publish = useCallback(
    (next: number) => {
      if (next !== committed.current) {
        committed.current = next;
        onChange(name, next);
      }
    },
    [name, onChange]
  );
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.valueAsNumber;
      setDraft(next);
      if (!commitOnRelease) {
        publish(next);
      }
    },
    [commitOnRelease, publish]
  );
  const commit = useCallback(
    (event: SyntheticEvent<HTMLInputElement>) => {
      if (commitOnRelease) {
        publish(event.currentTarget.valueAsNumber);
      }
    },
    [commitOnRelease, publish]
  );
  const cancel = useCallback(() => setDraft(value), [value]);
  const keyUp = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(event.key)
      ) {
        commit(event);
      }
    },
    [commit]
  );
  return (
    <label className="spyglass-control spyglass-setting">
      <span>
        {label}
        <output>
          {draft.toFixed(step < 1 ? 2 : 0)}
          {unit}
        </output>
      </span>
      <input
        aria-label={label}
        disabled={disabled}
        max={max}
        min={min}
        name={name}
        onBlur={commit}
        onChange={change}
        onKeyUp={keyUp}
        onPointerCancel={cancel}
        onPointerUp={commit}
        step={step}
        type="range"
        value={draft}
      />
    </label>
  );
}

export function SettingsToggle<Key extends string>({
  name,
  label,
  checked,
  disabled = false,
  onChange,
}: {
  name: Key;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (key: Key, value: boolean) => void;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(name, event.currentTarget.checked),
    [name, onChange]
  );
  return (
    <label className="spyglass-control spyglass-toggle">
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
        name={name}
        onChange={change}
        type="checkbox"
      />
    </label>
  );
}

export function SettingsSelect<Key extends string>({
  name,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  name: Key;
  label: string;
  value: string;
  disabled?: boolean;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (key: Key, value: string) => void;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const option = options.find(
        (item) => item.value === event.currentTarget.value
      );
      if (option && !option.disabled) {
        onChange(name, option.value);
      }
    },
    [name, onChange, options]
  );
  return (
    <label className="spyglass-control spyglass-appearance-control">
      <span>{label}</span>
      <select
        aria-label={label}
        disabled={disabled}
        name={name}
        onChange={change}
        value={value}
      >
        {options.map((option) => (
          <option
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
