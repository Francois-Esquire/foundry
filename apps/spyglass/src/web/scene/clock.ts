import { uniform } from "three/tsl";
import type { UniformNode } from "three/webgpu";

/**
 * A scene's clock: the seconds the scene has been in motion, as a uniform a
 * material reads for its movement (the weather's surf and clouds). The scene
 * advances it once per frame, before any layer updates, and hands the same
 * value to each layer's update. Under reduced motion a frame ticks the clock
 * without advancing it, so a pan leaves every animated layer at the phase it
 * stood at. Each scene makes its own, so two charts on one page keep time
 * apart.
 */
export interface SceneClock {
  /** Releases the uniform; the materials that read it are gone by then. */
  dispose: () => void;
  /**
   * Ticks the clock at `now` and returns its seconds: advanced by the time
   * since the last tick while motion continues. A pause and the first
   * resumed tick hold the phase, excluding time spent without frames.
   */
  tick: (now?: number, moving?: boolean) => number;
  /** The seconds, as the materials read them. */
  time: UniformNode<"float", number>;
}

/** A clock at zero, whose first tick counts from `start`. */
export function createClock(start = performance.now()): SceneClock {
  const time = uniform(0);
  let last = start;
  let seconds = 0;
  let wasMoving = true;
  return {
    dispose: () => {
      time.dispose();
    },
    tick(now = performance.now(), moving = true) {
      if (moving && wasMoving) {
        seconds += (now - last) / 1000;
      }
      wasMoving = moving;
      last = now;
      time.value = seconds;
      return seconds;
    },
    time,
  };
}
