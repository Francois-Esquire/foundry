import "./settings-controls.css";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  Param,
  ParamGroupOf,
  ParamSchema,
  ParamValues,
} from "../islands/lab/params";

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

type ParamValue = boolean | number | string;

function SettingsToggle({
  disabled,
  label,
  name,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  name: string;
  onChange: (key: string, value: boolean) => void;
  value: boolean;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(name, event.currentTarget.checked),
    [name, onChange]
  );
  return (
    <label className="spyglass-boundary-control spyglass-layer-control">
      <input
        checked={value}
        disabled={disabled}
        name={name}
        onChange={change}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * One param's control, from its spec (`lab/params.ts`): a range for a
 * number, a list for a choice, a checkbox for a toggle, each under the
 * spec's label (its key without one). The viewer declares no colour or
 * seed params, so it has no control for them.
 */
function ParamSetting({
  disabled,
  name,
  onChange,
  spec,
  value,
}: {
  disabled: boolean;
  name: string;
  onChange: (key: string, value: ParamValue) => void;
  spec: Param;
  value: ParamValue;
}) {
  const label = spec.label ?? name;
  switch (spec.kind) {
    case "number":
      return (
        <SettingsRange
          disabled={disabled}
          label={label}
          max={spec.max}
          min={spec.min}
          name={name}
          onChange={onChange}
          step={spec.step}
          unit={spec.unit}
          value={Number(value)}
        />
      );
    case "select":
      return (
        <SettingsSelect
          disabled={disabled}
          label={label}
          name={name}
          onChange={onChange}
          options={spec.options.map((option) => ({
            label: spec.labels?.[option] ?? option,
            value: option,
          }))}
          value={String(value)}
        />
      );
    case "toggle":
      return (
        <SettingsToggle
          disabled={disabled}
          label={label}
          name={name}
          onChange={onChange}
          value={Boolean(value)}
        />
      );
    default:
      return null;
  }
}

/**
 * One section of a settings panel, drawn from a param schema and its
 * layout group: the group's title and hint, then a control for each of its
 * params in the group's order. `children` go between the hint and the
 * controls, for a control the schema does not hold (a preset over a param).
 */
export function ParamSection<S extends ParamSchema>({
  children,
  disabled,
  group,
  onChange,
  schema,
  values,
}: {
  children?: ReactNode;
  disabled: boolean;
  group: ParamGroupOf<S>;
  onChange: (key: keyof S & string, value: ParamValues<S>[keyof S]) => void;
  schema: S;
  values: ParamValues<S>;
}) {
  const change = useCallback(
    (key: string, value: ParamValue) =>
      onChange(key, value as ParamValues<S>[keyof S]),
    [onChange]
  );
  return (
    <section aria-label={group.title}>
      <h3>{group.title}</h3>
      {group.hint && <p>{group.hint}</p>}
      {children}
      {group.keys.map((key) => (
        <ParamSetting
          disabled={disabled}
          key={key}
          name={key}
          onChange={change}
          spec={schema[key] as Param}
          value={values[key]}
        />
      ))}
    </section>
  );
}
