import { expect, it } from "vitest";
import { sceneTime, tickClock } from "../../src/web/scene/clock";

it("keeps the seconds since the scene opened as a uniform, advanced once per tick", () => {
  const first = tickClock();
  expect(first).toBeGreaterThanOrEqual(0);
  expect(sceneTime.value).toBe(first);
  const later = tickClock(performance.now() + 1500);
  expect(later - first).toBeGreaterThanOrEqual(1.5);
  expect(later - first).toBeLessThan(1.6);
  expect(sceneTime.value).toBe(later);
});
