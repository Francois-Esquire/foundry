import { type ReactNode, useCallback } from "react";
import { formatNumber } from "~/ui/content/output-format";
import { Checkbox } from "~/ui/controls/checkbox";
import { toggled } from "./plan-draft";
import type { SelectionOption } from "./selection-options";

interface OptionCheckProps<Value extends string> {
  readonly onChange: (values: Value[]) => void;
  readonly option: SelectionOption<Value>;
  readonly selected: readonly Value[];
}

function OptionCheck<Value extends string>({
  onChange,
  option,
  selected,
}: OptionCheckProps<Value>) {
  const toggle = useCallback(
    (on: boolean) => onChange(toggled(selected, option.value, on)),
    [onChange, option.value, selected]
  );
  return (
    <li>
      <Checkbox
        checked={selected.includes(option.value)}
        label={`${option.name}, ${formatNumber(option.count)}`}
        onChange={toggle}
      />
    </li>
  );
}

interface OptionChecksProps<Value extends string> {
  /** Shown above the list, such as a search field. */
  readonly children?: ReactNode;
  /** What to say when there is nothing to choose from. */
  readonly empty: string;
  readonly legend: string;
  readonly onChange: (values: Value[]) => void;
  readonly options: readonly SelectionOption<Value>[];
  readonly selected: readonly Value[];
}

/**
 * A named group of choices, any number of which can be on. Each is printed
 * with how many of the faces' characters it holds.
 */
export function OptionChecks<Value extends string>({
  children,
  empty,
  legend,
  onChange,
  options,
  selected,
}: OptionChecksProps<Value>) {
  return (
    <fieldset className="ty-export-options">
      <legend className="ty-label">{legend}</legend>
      {children}
      {options.length > 0 ? (
        <ul>
          {options.map((option) => (
            <OptionCheck
              key={option.value}
              onChange={onChange}
              option={option}
              selected={selected}
            />
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </fieldset>
  );
}
