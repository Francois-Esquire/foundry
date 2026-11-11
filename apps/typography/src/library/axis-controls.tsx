import { useCallback } from "react";
import {
  type AxisLocation,
  clampLocation,
  type FaceDescription,
  instanceAt,
  type VariationAxis,
} from "~/typeface/face";
import { Select } from "~/ui/controls/select";
import { Slider } from "~/ui/controls/slider";
import { type AxisStop, axisStep, axisStops, moveAxis } from "./axis-stops";

const CUSTOM = "custom";

interface AxisSliderProps {
  readonly axis: VariationAxis;
  readonly location: AxisLocation;
  readonly onLocation: (location: AxisLocation) => void;
  readonly stops: readonly AxisStop[];
}

function AxisSlider({ axis, location, onLocation, stops }: AxisSliderProps) {
  const move = useCallback(
    (value: number) => onLocation(moveAxis(location, axis.tag, value)),
    [axis.tag, location, onLocation]
  );
  return (
    <Slider
      label={axis.name}
      max={axis.max}
      min={axis.min}
      onChange={move}
      step={axisStep(axis)}
      stops={stops}
      value={location[axis.tag] ?? axis.default}
    />
  );
}

interface AxisControlsProps {
  /** The variable face's axes and the instances its font names. */
  readonly description: Pick<FaceDescription, "axes" | "instances">;
  readonly location: AxisLocation;
  readonly onLocation: (location: AxisLocation) => void;
}

/**
 * A slider for each variation axis, stepped to the axis, with a stop where a
 * named instance moves that axis alone.
 */
export function AxisSliders({
  description: { axes, instances },
  location,
  onLocation,
}: AxisControlsProps) {
  return (
    <>
      {axes.map((axis) => (
        <AxisSlider
          axis={axis}
          key={axis.tag}
          location={location}
          onLocation={onLocation}
          stops={axisStops(axis, axes, instances)}
        />
      ))}
    </>
  );
}

/**
 * Setting a location on a variable face: the instances its font names, and
 * a slider for each axis. Every place that sets a location uses this.
 */
export function AxisControls({
  description,
  location,
  onLocation,
}: AxisControlsProps) {
  const { axes, instances } = description;
  const here = instanceAt(description, location);
  const chooseInstance = useCallback(
    (name: string) => {
      const chosen = instances.find((instance) => instance.name === name);
      if (chosen) {
        onLocation(clampLocation(axes, chosen.location));
      }
    },
    [axes, instances, onLocation]
  );
  return (
    <>
      {instances.length > 0 ? (
        <Select
          label="Named instance"
          onChange={chooseInstance}
          options={[
            ...(here
              ? []
              : [{ label: "A location of its own", value: CUSTOM }]),
            ...instances.map(({ name }) => ({ label: name, value: name })),
          ]}
          value={here?.name ?? CUSTOM}
        />
      ) : null}
      <AxisSliders
        description={description}
        location={location}
        onLocation={onLocation}
      />
    </>
  );
}
