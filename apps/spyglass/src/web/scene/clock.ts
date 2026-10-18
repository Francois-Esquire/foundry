import { uniform } from "three/tsl";

/**
 * The scene's clock: seconds since the scene opened, as a uniform a material
 * may read for its motion. The scene advances it once per frame, before any
 * layer updates, and hands the same value to each layer's update; nothing
 * reads it yet, since no layer animates.
 */
export const sceneTime = uniform(0);

const opened = performance.now();

/** Advances the clock to `now` and returns its seconds. */
export function tickClock(now = performance.now()): number {
  sceneTime.value = (now - opened) / 1000;
  return sceneTime.value;
}
