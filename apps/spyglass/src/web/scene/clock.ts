import { uniform } from "three/tsl";

/**
 * The scene's clock: the seconds the scene has been in motion, as a uniform a
 * material reads for its movement (the weather's surf and clouds). The scene
 * advances it once per frame, before any layer updates, and hands the same
 * value to each layer's update. Under reduced motion a frame ticks the clock
 * without advancing it, so a pan leaves every animated layer at the phase it
 * stood at.
 */
export const sceneTime = uniform(0);

let last = performance.now();
let seconds = 0;

/**
 * Ticks the clock at `now` and returns its seconds: advanced by the time since
 * the last tick while `moving`, held where it is otherwise.
 */
export function tickClock(now = performance.now(), moving = true): number {
  if (moving) {
    seconds += (now - last) / 1000;
  }
  last = now;
  sceneTime.value = seconds;
  return seconds;
}
