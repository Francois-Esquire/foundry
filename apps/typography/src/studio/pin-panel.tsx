import { useCallback } from "react";
import { AxisControls } from "~/library/axis-controls";
import { type AxisLocation, type Face, faceStyleName } from "~/typeface/face";
import { Button, ButtonLink } from "~/ui/controls/button";
import { styleNameAt } from "./pinning";
import { studioHash } from "./studio-address";

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
  const styleName = styleNameAt(description, location);
  const pin = useCallback(
    () => onPin(location, styleName),
    [location, onPin, styleName]
  );
  return (
    <div className="ty-studio-pin">
      <AxisControls
        description={description}
        location={location}
        onLocation={onLocation}
      />
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
