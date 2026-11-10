import { useCallback, useMemo } from "react";
import {
  type AxisLocation,
  type Face,
  faceStyleName,
  type VariationAxis,
} from "~/typeface/face";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Select } from "~/ui/controls/select";
import { Slider } from "~/ui/controls/slider";
import { instanceAt, styleNameAt } from "./pinning";
import { studioHash } from "./studio-address";

const CUSTOM = "custom";

interface AxisSliderProps {
  readonly axis: VariationAxis;
  readonly location: AxisLocation;
  readonly onLocation: (location: AxisLocation) => void;
  readonly stops: readonly { readonly name: string; readonly value: number }[];
}

function AxisSlider({ axis, location, onLocation, stops }: AxisSliderProps) {
  const change = useCallback(
    (value: number) => onLocation({ ...location, [axis.tag]: value }),
    [axis.tag, location, onLocation]
  );
  return (
    <Slider
      label={axis.name}
      max={axis.max}
      min={axis.min}
      onChange={change}
      stops={stops}
      value={location[axis.tag] ?? axis.default}
    />
  );
}

interface PinPanelProps {
  readonly face: Face;
  readonly location: AxisLocation;
  readonly onLocation: (location: AxisLocation) => void;
  /** Pins the location under a style name and opens the pinned instance. */
  readonly onPin: (location: AxisLocation, styleName: string) => void;
  /** Instances of this face that are already pinned. */
  readonly pinned: readonly Face[];
}

/**
 * Choosing an instance of a variable face to edit. A variable face is only
 * looked at; the pinned instance becomes an editable face of its own.
 */
export function PinPanel({
  face,
  location,
  onLocation,
  onPin,
  pinned,
}: PinPanelProps) {
  const { description } = face;
  const here = instanceAt(description, location);
  const styleName = styleNameAt(description, location);
  const options = useMemo(
    () => [
      ...description.instances.map((instance) => ({
        label: instance.name,
        value: instance.name,
      })),
      { label: "Custom location", value: CUSTOM },
    ],
    [description.instances]
  );
  const chooseInstance = useCallback(
    (name: string) => {
      const chosen = description.instances.find(
        (instance) => instance.name === name
      );
      if (chosen) {
        onLocation(chosen.location);
      }
    },
    [description.instances, onLocation]
  );
  const pin = useCallback(
    () => onPin(location, styleName),
    [location, onPin, styleName]
  );
  // An axis shows a stop where a named instance moves that axis alone.
  const stopsFor = (axis: VariationAxis) =>
    description.instances
      .filter((instance) =>
        description.axes.every(
          (other) =>
            other.tag === axis.tag ||
            (instance.location[other.tag] ?? other.default) === other.default
        )
      )
      .map((instance) => ({
        name: instance.name,
        value: instance.location[axis.tag] ?? axis.default,
      }));
  return (
    <div className="ty-studio-pin">
      {description.instances.length > 0 ? (
        <Select
          label="Named instance"
          onChange={chooseInstance}
          options={options}
          value={here?.name ?? CUSTOM}
        />
      ) : null}
      {description.axes.map((axis) => (
        <AxisSlider
          axis={axis}
          key={axis.tag}
          location={location}
          onLocation={onLocation}
          stops={stopsFor(axis)}
        />
      ))}
      <div className="ty-studio-row">
        <Button onClick={pin} symbol="pin" variant="solid">
          Pin {styleName}
        </Button>
      </div>
      {pinned.length > 0 ? (
        <div className="ty-studio-row">
          <span className="ty-label">Pinned already</span>
          {pinned.map((instance) => (
            <ButtonLink href={studioHash(instance.id)} key={instance.id}>
              Open {faceStyleName(instance)}
            </ButtonLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
