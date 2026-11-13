import { useCallback, useMemo } from "react";
import { distinctWeights, FEWEST_WEIGHTS } from "~/generation/family/weights";
import type { Face, VariationAxis } from "~/typeface/face";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Slider } from "~/ui/controls/slider";
import { namedWeights, otherAxesOf, weightName, weightToAdd } from "./weights";

interface WeightRowProps {
  readonly axis: VariationAxis;
  readonly disabled: boolean;
  readonly index: number;
  readonly onMove: (index: number, weight: number) => void;
  readonly onRemove: (index: number) => void;
  readonly removable: boolean;
  readonly stops: readonly { readonly name: string; readonly value: number }[];
  readonly weight: number;
}

function WeightRow({
  axis,
  disabled,
  index,
  onMove,
  onRemove,
  removable,
  stops,
  weight,
}: WeightRowProps) {
  const move = useCallback(
    (next: number) => onMove(index, next),
    [index, onMove]
  );
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <li className="ty-family-weight">
      <Slider
        disabled={disabled}
        label={`Weight ${index + 1}`}
        max={axis.max}
        min={axis.min}
        onChange={move}
        stops={stops}
        value={weight}
      />
      <Button
        disabled={disabled || !removable}
        onClick={remove}
        symbol="remove"
      >
        Remove weight {index + 1}
      </Button>
    </li>
  );
}

interface WeightsSectionProps {
  readonly axis: VariationAxis;
  /** True while a run is under way. */
  readonly disabled: boolean;
  /** The weights as entered, in the order of the rows. */
  readonly entered: readonly number[];
  readonly face: Face;
  readonly onChange: (weights: readonly number[]) => void;
}

/**
 * The weights a coordinated run works at. Each can be moved along the axis,
 * typed, or set to one of the face's named instances.
 */
export function WeightsSection({
  axis,
  disabled,
  entered,
  face,
  onChange,
}: WeightsSectionProps) {
  const stops = useMemo(
    () =>
      namedWeights(face).map(({ name, weight }) => ({ name, value: weight })),
    [face]
  );
  const move = useCallback(
    (index: number, weight: number) =>
      onChange(entered.map((old, at) => (at === index ? weight : old))),
    [entered, onChange]
  );
  const remove = useCallback(
    (index: number) => onChange(entered.filter((_, at) => at !== index)),
    [entered, onChange]
  );
  const add = useCallback(
    () => onChange([...entered, weightToAdd(axis, entered)]),
    [axis, entered, onChange]
  );
  const weights = distinctWeights(axis, entered);
  const others = otherAxesOf(face);
  return (
    <div className="ty-generate-stack">
      <ol aria-label="Weights to generate at" className="ty-family-weights">
        {entered.map((weight, index) => (
          <WeightRow
            axis={axis}
            disabled={disabled}
            index={index}
            // Rows have no identity but their place: removing one renumbers the rest.
            key={index}
            onMove={move}
            onRemove={remove}
            removable={entered.length > FEWEST_WEIGHTS}
            stops={stops}
            weight={weight}
          />
        ))}
      </ol>
      <div className="ty-generate-actions">
        <Button disabled={disabled} onClick={add} symbol="add">
          Add a weight
        </Button>
        <span className="ty-generate-reason" data-testid="family-weights">
          {weights.length} {weights.length === 1 ? "weight" : "weights"},
          lightest first:{" "}
          {weights
            .map((weight) => `${weightName(face, weight)} (${weight})`)
            .join(", ")}
          . Each becomes a pinned instance of {face.description.familyName} when
          the run has made something for it.
        </span>
      </div>
      {weights.length < FEWEST_WEIGHTS ? (
        <Notice tone="problem">
          A run across weights needs at least two different weights, and these
          entries come to {weights.length}. Move one of them, or add a weight.
        </Notice>
      ) : null}
      {others.length > 0 ? (
        <Notice>
          Coordinated generation works on the weight axis only.{" "}
          {others
            .map(
              (other) => `${other.name} stays at its default, ${other.default}`
            )
            .join(", and ")}
          , at every weight.
        </Notice>
      ) : null}
    </div>
  );
}
