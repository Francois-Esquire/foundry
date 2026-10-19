import { expect, it } from "vitest";
import { foundationRelief } from "../../src/web/layout/foundation-relief";

function shelf(count = 1) {
  const width = 40;
  const values = new Float32Array(width * width * 2);
  for (let y = 10; y < 30; y += 1) {
    for (let x = 10; x < 30; x += 1) {
      values[(y * width + x) * 2] = count;
    }
  }
  return { height: width, values, width };
}
const extent = { height: 200, width: 200 };
const at = (data: Float32Array, x: number, y: number, channel = 0) =>
  data[(y * 40 + x) * 2 + channel] ?? 0;

it("lights the northwest lip and shades the southeast drop without shading flat interiors", () => {
  const relief = foundationRelief(shelf(), extent);
  expect(at(relief, 10, 20, 1)).toBeGreaterThan(0);
  expect(at(relief, 29, 20, 1)).toBeLessThan(0);
  expect(at(relief, 20, 10, 1)).toBeGreaterThan(0);
  expect(at(relief, 20, 29, 1)).toBeLessThan(0);
  expect(at(relief, 20, 20, 1)).toBe(0);
  expect(at(relief, 0, 0)).toBe(0);
});

it("raises overlapping shelves monotonically within a normalized depth range", () => {
  const heights = [1, 2, 3, 300].map((count) =>
    at(foundationRelief(shelf(count), extent), 20, 20)
  );
  const [one = 0, two = 0, three = 0, many = 0] = heights;
  expect(two).toBeGreaterThan(one);
  expect(three).toBeGreaterThan(two);
  expect(many).toBeGreaterThan(three);
  const field = foundationRelief(shelf(300), extent);
  expect(field.every(Number.isFinite)).toBe(true);
  expect(
    field
      .filter((_, i) => i % 2 === 0)
      .every((height) => height >= 0 && height <= 1)
  ).toBe(true);
  expect(
    field.filter((_, i) => i % 2 === 1).every((slope) => Math.abs(slope) <= 1)
  ).toBe(true);
});

it("leaves an empty or invalid extent neutral", () => {
  expect(foundationRelief(shelf(0), extent).every((value) => value === 0)).toBe(
    true
  );
  expect(
    foundationRelief(shelf(), { height: 0, width: 0 }).every(
      (value) => value === 0
    )
  ).toBe(true);
});
