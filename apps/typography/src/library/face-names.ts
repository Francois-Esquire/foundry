/** How a face is named and described in lists: its label, weight, width and kind. */
import {
  type Face,
  faceStyleName,
  isVariable,
  locationLabel,
  type VariationAxis,
} from "~/typeface/face";

/** The OS/2 weight classes, by their usual names. */
const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

/** The OS/2 width classes, 1 to 9. */
const WIDTH_NAMES: readonly string[] = [
  "Ultra condensed",
  "Extra condensed",
  "Condensed",
  "Semi condensed",
  "Normal",
  "Semi expanded",
  "Expanded",
  "Extra expanded",
  "Ultra expanded",
];

/** "Lato Regular": the family and the style, as a person would say it. */
export const faceLabel = (face: Face) =>
  `${face.description.familyName} ${faceStyleName(face)}`;

/** "400 Regular", or the bare number for a weight class without a usual name. */
export const weightLabel = (weightClass: number) => {
  const name = WEIGHT_NAMES[weightClass];
  return name ? `${weightClass} ${name}` : String(weightClass);
};

/** "5 Normal", or the bare number outside the nine width classes. */
export const widthLabel = (widthClass: number) => {
  const name = WIDTH_NAMES[widthClass - 1];
  return name ? `${widthClass} ${name}` : String(widthClass);
};

const axisRange = (axis: VariationAxis) =>
  `${axis.name} ${axis.min} to ${axis.max}`;

/** Whether a face is static, variable or a pinned instance, with its axes. */
export const variationLabel = (face: Face) => {
  if (face.pinned) {
    return `Pinned at ${locationLabel(face.pinned.location)}`;
  }
  return isVariable(face)
    ? `Variable: ${face.description.axes.map(axisRange).join(", ")}`
    : "Static";
};
