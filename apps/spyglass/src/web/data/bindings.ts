import { fileFootprint } from "../../lib/file-placement";

export function footprint(size: number) {
  return fileFootprint(size);
}

export function latitude(layer: number) {
  return -220 * layer;
}

export function territoryLabelSize(radius: number) {
  return Math.max(13, Math.min(22, radius * 0.15));
}

export function labelPriority(dependents: number, dependencies: number) {
  return dependents + dependencies;
}

/** Fixed chart coordinates; reveal fifths only when their spacing has room. */
export function chartGrid(pixels: number) {
  return {
    majorStep: 90,
    minorOpacity: 0.14 * Math.max(0, Math.min(1, (18 * pixels - 30) / 30)),
    minorStep: 18,
  };
}

export const paperThickness = 0.4;
