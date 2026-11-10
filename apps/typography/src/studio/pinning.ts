/** Naming the instance of a variable face that is about to be pinned. */
import type { AxisLocation, FaceDescription } from "~/typeface/face";

const sameLocation = (
  description: FaceDescription,
  a: AxisLocation,
  b: AxisLocation
) =>
  description.axes.every(
    (axis) => (a[axis.tag] ?? axis.default) === (b[axis.tag] ?? axis.default)
  );

/** The named instance that sits exactly at a location, if the font names one. */
export const instanceAt = (
  description: FaceDescription,
  location: AxisLocation
) =>
  description.instances.find((instance) =>
    sameLocation(description, instance.location, location)
  );

/** The style name for a pinned instance: the font's own name for it, or its axis values. */
export const styleNameAt = (
  description: FaceDescription,
  location: AxisLocation
) =>
  instanceAt(description, location)?.name ??
  description.axes
    .map((axis) => `${axis.tag} ${location[axis.tag] ?? axis.default}`)
    .join(", ");
