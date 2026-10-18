import { expect, it } from "vitest";
import { sceneTime, tickClock } from "../../src/web/scene/clock";

it("keeps the seconds the scene has moved as a uniform, advanced once per tick", () => {
  const first = tickClock();
  expect(first).toBeGreaterThanOrEqual(0);
  expect(sceneTime.value).toBe(first);
  const later = tickClock(performance.now() + 1500);
  expect(later - first).toBeGreaterThanOrEqual(1.5);
  expect(later - first).toBeLessThan(1.6);
  expect(sceneTime.value).toBe(later);
});

it("holds where it stands when a frame is drawn under reduced motion", () => {
  const now = performance.now();
  const before = tickClock(now);
  // The pan's frames tick the clock without advancing it.
  expect(tickClock(now + 3000, false)).toBe(before);
  expect(sceneTime.value).toBe(before);
  // Motion allowed again: the clock goes on from where it held, not from the wall.
  const after = tickClock(now + 3500);
  expect(after - before).toBeCloseTo(0.5, 6);
});
