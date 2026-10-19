import { expect, it } from "vitest";
import { chartFrame } from "../../src/web/layout/chart-frame";

it("keeps an inset lining without enclosures when no coordinates are visible", () => {
  const frame = chartFrame(400, 300, []);
  expect(frame.border).toBe("M28 18 H392 V292 H18 V28");
  expect(frame.ornament).toBe("");
  expect(frame.panels).toBe("");
});

it("splits symmetrically above and below letters, following the first and last positions", () => {
  const references = [
    { edge: "top" as const, halfWidth: 4, position: 100 },
    { edge: "top" as const, halfWidth: 4, position: 200 },
  ];
  const frame = chartFrame(400, 300, references);
  expect(frame.border).toContain("M82 18 L90 10 H210 L218 18 L210 26 H90 Z");
  expect(frame.panels).toBe("M82 18 L90 10 H210 L218 18 L210 26 H90 Z");
  const panned = chartFrame(
    400,
    300,
    references.map((reference) => ({
      ...reference,
      position: reference.position + 20,
    }))
  );
  expect(panned.border).toContain(
    "M102 18 L110 10 H230 L238 18 L230 26 H110 Z"
  );
  expect(chartFrame(400, 300, references.slice(1)).border).toContain(
    "M182 18 L190 10 H210 L218 18 L210 26 H190 Z"
  );
});

it("splits equally left and right of the numbers", () => {
  const frame = chartFrame(400, 300, [
    { edge: "left", halfWidth: 6, position: 120 },
  ]);
  expect(frame.border).toContain("M18 100 L10 108 V132 L18 140 L26 132 V108 Z");
});

it("joins the row and column at the points of the persistent diamond", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: 40 },
    { edge: "left", halfWidth: 6, position: 40 },
  ]);
  expect(frame.corner).toBe("M18 8 L28 18 L18 28 L8 18 Z");
  expect(frame.panels).toContain("M28 18 L36 10");
  expect(frame.panels).toContain("M18 28 L10 36");
});

it("keeps the corner and both closing Vs visible and stable while between the outer limits", () => {
  for (const shift of [0, -25, -75]) {
    const frame = chartFrame(400, 300, [
      { edge: "top", halfWidth: 4, position: -100 + shift },
      { edge: "top", halfWidth: 4, position: 600 + shift },
      { edge: "left", halfWidth: 6, position: -100 + shift },
      { edge: "left", halfWidth: 6, position: 500 + shift },
    ]);
    expect(frame.corner).toBe("M18 8 L28 18 L18 28 L8 18 Z");
    expect(frame.border).toContain("H372 L380 18 L372 26");
    expect(frame.border).toContain("V272 L18 280 L26 272");
    expect(frame.border).toContain("M386 18 H392 V292 H18 V286");
    expect(frame.ornament).toContain("M383 15 L386 18 L383 21 L380 18 Z");
  }
});

it("returns to the single lining after the entire coordinate range passes the edge", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: -100 },
    { edge: "top", halfWidth: 4, position: -50 },
  ]);
  expect(frame.border).toBe("M28 18 H392 V292 H18 V28");
  expect(frame.ornament).toBe("");
});

it("moves the V inward with the actual limit and leaves a single rule beyond it", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: -100 },
    { edge: "top", halfWidth: 4, position: 300 },
    { edge: "left", halfWidth: 6, position: -100 },
    { edge: "left", halfWidth: 6, position: 200 },
  ]);
  expect(frame.border).toContain("H310 L318 18 L310 26");
  expect(frame.border).toContain("V212 L18 220 L26 212");
  expect(frame.border).toContain("M324 18 H392 V292 H18 V226");
});

it("gives disconnected starts the same diamond finials and clearances as their far ends", () => {
  const frame = chartFrame(400, 300, [
    { edge: "top", halfWidth: 4, position: -100 },
    { edge: "top", halfWidth: 4, position: 200 },
    { edge: "left", halfWidth: 6, position: 120 },
  ]);
  expect(frame.corner).toBe("M18 8 L28 18 L18 28 L8 18 Z");
  expect(frame.panels).toContain("M30 18 L38 10");
  expect(frame.border).toContain("M28 18 H28");
  expect(frame.ornament).toContain("M27 15 L30 18 L27 21 L24 18 Z");
  expect(frame.ornament).toContain("M18 94 L21 97 L18 100 L15 97 Z");
});

it("keeps the same corner diamond when detached, joined, or without coordinate rows", () => {
  const states = [
    [],
    [{ edge: "top" as const, halfWidth: 4, position: 150 }],
    [
      { edge: "top" as const, halfWidth: 4, position: -100 },
      { edge: "left" as const, halfWidth: 6, position: -100 },
    ],
  ];
  for (const references of states) {
    expect(chartFrame(400, 300, references).corner).toBe(
      "M18 8 L28 18 L18 28 L8 18 Z"
    );
  }
});
