/** Naming the instance of a variable face that is about to be pinned. */
import {
  type AxisLocation,
  type FaceDescription,
  instanceAt,
} from "~/typeface/face";

/** The style name for a pinned instance: the font's own name for it, or its axis values. */
export const styleNameAt = (
  description: FaceDescription,
  location: AxisLocation
) =>
  instanceAt(description, location)?.name ??
  description.axes
    .map((axis) => `${axis.tag} ${location[axis.tag] ?? axis.default}`)
    .join(", ");
