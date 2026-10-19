import { expect, it } from "vitest";
import { chartFrame } from "../../src/web/layout/chart-frame";

it("keeps an inset lining without enclosures when no coordinates are visible", () => {
  const frame = chartFrame(400, 300, []);
  expect(frame.border).toBe("M18 18 H392 V292 H18 V18");
  expect(frame.ornament).toBe("");
});

it("splits symmetrically above and below letters, following the first and last positions", () => {
  const references = [
    { edge: "top" as const, halfWidth: 4, position: 100 },
    { edge: "top" as const, halfWidth: 4, position: 200 },
  ];
  const frame = chartFrame(400, 300, references);
  expect(frame.border).toContain("M80 18 L90 8 H210 L220 18 L210 28 H90 Z");
  const panned = chartFrame(
    400,
    300,
    references.map((reference) => ({
      ...reference,
      position: reference.position + 20,
    }))
  );
  expect(panned.border).toContain("M100 18 L110 8 H230 L240 18 L230 28 H110 Z");
  expect(chartFrame(400, 300, references.slice(1)).border).toContain(
    "M180 18 L190 8 H210 L220 18 L210 28 H190 Z"
  );
});

it("splits equally left and right of the numbers", () => {
  const frame = chartFrame(400, 300, [
    { edge: "left", halfWidth: 6, position: 120 },
  ]);
  expect(frame.border).toContain("M18 98 L8 108 V132 L18 142 L28 132 V108 Z");
});

it("joins both branches into a square where the coordinate runs meet", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: 40 },
    { edge: "left", halfWidth: 6, position: 40 },
  ]);
  expect(frame.border).toContain("M8 52 V8 H50");
  expect(frame.border).toContain("M28 52 V28 H50");
  expect(frame.ornament).toBe("M18 16 l2 2 -2 2 -2 -2 Z");
});

it("keeps the corner and both closing Vs visible and stable while between the outer limits", () => {
  for (const shift of [0, -25, -75]) {
    const frame = chartFrame(400, 300, [
      { edge: "top", halfWidth: 4, position: -100 + shift },
      { edge: "top", halfWidth: 4, position: 600 + shift },
      { edge: "left", halfWidth: 6, position: -100 + shift },
      { edge: "left", halfWidth: 6, position: 500 + shift },
    ]);
    expect(frame.ornament).toBe("M18 16 l2 2 -2 2 -2 -2 Z");
    expect(frame.border).toContain("V8 H382");
    expect(frame.border).toContain("V28 H382");
    expect(frame.border).toContain("M382 8 L392 18 L382 28");
    expect(frame.border).toContain("M8 282 L18 292 L28 282");
    expect(frame.border).toContain("M392 18 H392 V292 H18 V292");
  }
});

it("returns to the single lining after the entire coordinate range passes the edge", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: -100 },
    { edge: "top", halfWidth: 4, position: -50 },
  ]);
  expect(frame.border).toBe("M18 18 H392 V292 H18 V18");
  expect(frame.ornament).toBe("");
});

it("moves the V inward with the actual limit and leaves a single rule beyond it", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: -100 },
    { edge: "top", halfWidth: 4, position: 300 },
    { edge: "left", halfWidth: 6, position: -100 },
    { edge: "left", halfWidth: 6, position: 200 },
  ]);
  expect(frame.border).toContain("M310 8 L320 18 L310 28");
  expect(frame.border).toContain("M8 212 L18 222 L28 212");
  expect(frame.border).toContain("M320 18 H392 V292 H18 V222");
});
