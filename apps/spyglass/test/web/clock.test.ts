import { expect, it } from "vitest";
import { createClock } from "../../src/web/scene/clock";

it("keeps the seconds the scene has moved as a uniform, advanced once per tick", () => {
  const start = performance.now();
  const clock = createClock(start);
  const first = clock.tick(start);
  expect(first).toBe(0);
  expect(clock.time.value).toBe(first);
  const later = clock.tick(start + 1500);
  expect(later - first).toBeCloseTo(1.5, 6);
  expect(clock.time.value).toBe(later);
  clock.dispose();
});

it("holds where it stands when a frame is drawn under reduced motion", () => {
  const now = performance.now();
  const clock = createClock(now);
  const before = clock.tick(now + 1000);
  // The pan's frames tick the clock without advancing it.
  expect(clock.tick(now + 4000, false)).toBe(before);
  expect(clock.time.value).toBe(before);
  // Motion allowed again: the clock goes on from where it held, not from the wall.
  expect(clock.tick(now + 4500)).toBe(before);
  const after = clock.tick(now + 5000);
  expect(after - before).toBeCloseTo(0.5, 6);
  clock.dispose();
});

it("resumes without counting an idle pause, even with no frames during it", () => {
  const clock = createClock(0);
  expect(clock.tick(1000)).toBe(1);
  expect(clock.tick(1100, false)).toBe(1);
  expect(clock.tick(11_100)).toBe(1);
  expect(clock.time.value).toBe(1);
  expect(clock.tick(11_600)).toBe(1.5);
  clock.dispose();
});

it("keeps time apart from another clock, and releases its uniform when disposed", () => {
  const now = performance.now();
  const one = createClock(now);
  const other = createClock(now);
  expect(one.time).not.toBe(other.time);
  one.tick(now + 2000);
  expect(one.time.value).toBeCloseTo(2, 6);
  expect(other.time.value).toBe(0);
  other.tick(now + 500);
  expect(one.time.value).toBeCloseTo(2, 6);
  expect(other.time.value).toBeCloseTo(0.5, 6);
  let released = 0;
  one.time.addEventListener("dispose", () => {
    released += 1;
  });
  one.dispose();
  expect(released).toBe(1);
  other.dispose();
});
