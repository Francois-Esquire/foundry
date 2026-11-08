import type { LabelScreen } from "../../src/web/layout/label-candidates";
import type { InkView } from "../../src/web/view/chart-view";

/**
 * The canvas a flat view covers, as the labels are placed on it: a camera
 * without perspective centred on the view's point, its north–south
 * foreshortened by the view's tilt (none without one), so the chart's
 * rectangle under the view is exactly the canvas.
 */
export function flatScreen(view: InkView): LabelScreen {
  const pixels = view.pixelsPerUnit;
  const squash = Math.cos(view.tilt ?? 0);
  const width = view.width * pixels;
  const height = view.height * pixels * squash;
  return {
    at: (label) => ({
      x: width / 2 + (label.x - view.x) * pixels,
      y: height / 2 + (label.y - view.y) * pixels * squash,
    }),
    height,
    pixelsPerUnit: pixels,
    width,
  };
}

/**
 * A perspective camera as Islands' is: looking north at the chart's origin
 * from `distance` units away, `pitch` radians above the horizon, with a
 * vertical field of view of `fieldOfView`, over a canvas of the given size.
 * Its scale at the origin, `pixelsPerUnit`, is the one Islands reports at
 * its target; `at` projects a chart point (y south) on the sea.
 */
export function perspectiveCamera(options: {
  distance: number;
  fieldOfView: number;
  height: number;
  pitch: number;
  width: number;
}) {
  const { distance, fieldOfView, height, pitch, width } = options;
  const focal = height / 2 / Math.tan(fieldOfView / 2);
  // The eye, south of the origin and above it; world y is up, z south.
  const eye = { y: distance * Math.sin(pitch), z: distance * Math.cos(pitch) };
  const project = (x: number, y: number) => {
    const up = -eye.y;
    const south = y - eye.z;
    const depth = -up * Math.sin(pitch) - south * Math.cos(pitch);
    const rise = up * Math.cos(pitch) - south * Math.sin(pitch);
    return {
      x: width / 2 + (focal * x) / depth,
      y: height / 2 - (focal * rise) / depth,
    };
  };
  const pixelsPerUnit = focal / distance;
  return {
    pixelsPerUnit,
    project,
    screen: {
      at: (label) => project(label.x, label.y),
      height,
      pixelsPerUnit,
      width,
    } satisfies LabelScreen,
  };
}
