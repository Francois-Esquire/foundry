import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { labelUnder } from "../../src/web/scene/exploration";
import { compassBox } from "../../src/web/scene/ink/compass";
import { paintCrossings } from "../../src/web/scene/ink/crossings";
import { inkState } from "../../src/web/scene/ink/state";
import { inks } from "../../src/web/scene/ink-ladder";
import { paintInk } from "../../src/web/scene/paint-map";
import type { AtlasData } from "../../src/web/types";
import { twins } from "../helpers/twins";

/** A 2D context that records what is stroked and filled, in which ink. */
function canvasFixture() {
  const ctx = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    fillText: vi.fn(),
    globalAlpha: 1,
    lineTo: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 1.5 }),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    resetTransform: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    strokeStyle: "",
    strokeText: vi.fn(),
    translate: vi.fn(),
  };
  return {
    canvas: {
      getContext: () => ctx,
      height: 500,
      width: 500,
    } as unknown as HTMLCanvasElement,
    ctx,
  };
}

/** A caption with nothing after its file count. */
const endsWithCount = /FILES?$/;

/** The whole chart at one pixel per unit. */
const whole = (atlas: AtlasData) => ({
  height: atlas.height,
  pixelsPerUnit: 1,
  width: atlas.width,
  x: 0,
  y: 0,
});

/** The crossing lines `paintCrossings` strokes, in the crossing's ink, with an island selected or none. */
function crossingStrokes(atlas: AtlasData, selected: string | null) {
  const { ctx } = canvasFixture();
  const inksStroked: string[] = [];
  ctx.stroke.mockImplementation(() => inksStroked.push(ctx.strokeStyle));
  const pen = ctx as unknown as CanvasRenderingContext2D;
  paintCrossings(
    inkState(pen, pen, { data: atlas, selected, view: whole(atlas) })
  );
  return {
    curves: ctx.quadraticCurveTo.mock.calls.length,
    inks: inksStroked,
  };
}

it("draws one line for each pair of packages a crossing joins, in the crossing's ink, and none for a single workspace", async () => {
  const { atlas, single } = await twins();
  const [crossing] = atlas.crossings ?? [];
  assert(crossing);
  // Two declarations of one pair, and the pair the other way round.
  const merged: AtlasData = {
    ...atlas,
    crossings: [
      crossing,
      { ...crossing, kind: "devDependencies" },
      { ...crossing, from: crossing.to, to: crossing.from },
    ],
  };
  const drawn = crossingStrokes(merged, null);
  expect(drawn.curves).toBe(2);
  expect(new Set(drawn.inks)).toEqual(new Set([inks.crossing]));
  expect(crossingStrokes(single, null).curves).toBe(0);
  // Never a route.
  expect(
    merged.routes.some(
      (route) => route.from === crossing.from && route.to === crossing.to
    )
  ).toBe(false);
});

it("keeps only the selected island's own crossings while an island is selected", async () => {
  const { atlas } = await twins();
  const [crossing] = atlas.crossings ?? [];
  assert(crossing);
  const other = atlas.territories.find(
    (island) => island.id !== crossing.from && island.id !== crossing.to
  );
  assert(other);
  expect(crossingStrokes(atlas, crossing.from).curves).toBe(1);
  expect(crossingStrokes(atlas, crossing.to).curves).toBe(1);
  expect(crossingStrokes(atlas, other.id).curves).toBe(0);
});

it("sets each frame's label above it, which a click passes through, and adds a frame's label to the captions of names two frames share", async () => {
  const { atlas, single } = await twins();
  const { canvas } = canvasFixture();
  const labels = paintInk(canvas, { data: atlas, view: whole(atlas) });
  const frames = labels.filter((label) => label.frame !== undefined);
  expect(frames.map((label) => label.text)).toEqual(["FIRST", "SECOND"]);
  // Each names its frame, and no island.
  expect(frames.map((label) => label.frame)).toEqual(
    atlas.frames.map((frame) => frame.id)
  );
  expect(frames.every((label) => label.territory === undefined)).toBe(true);
  for (const label of frames) {
    expect(labelUnder(labels, label.x, label.y - label.height / 2)).toBe(
      undefined
    );
  }
  const names = labels.filter((label) => label.caption);
  expect(names.length).toBeGreaterThan(0);
  for (const label of names) {
    const frame = atlas.frames.find((each) =>
      each.territories.includes(label.territory?.id ?? "")
    );
    expect(label.caption).toMatch(
      new RegExp(` · ${frame?.label.toUpperCase()}$`)
    );
  }
  // A name only one frame has keeps its caption as a single workspace's.
  const [, second] = atlas.frames;
  const renamed = atlas.territories.find((island) =>
    second?.territories.includes(island.id)
  );
  assert(renamed);
  const twin = atlas.territories.find(
    (island) => island.label === renamed.label && island.id !== renamed.id
  );
  const apart: AtlasData = {
    ...atlas,
    territories: atlas.territories.map((island) =>
      island.id === renamed.id ? { ...island, label: "Only here" } : island
    ),
  };
  const captions = new Map(
    paintInk(canvasFixture().canvas, { data: apart, view: whole(apart) })
      .filter((label) => label.caption)
      .map((label) => [label.territory?.id, label.caption])
  );
  assert(twin);
  for (const id of [renamed.id, twin.id]) {
    expect(captions.get(id)).toMatch(endsWithCount);
  }
  // A single workspace has no frame label, and no caption names one.
  const alone = paintInk(canvasFixture().canvas, {
    data: single,
    view: whole(single),
  });
  expect(alone.some((label) => label.frame !== undefined)).toBe(false);
  expect(alone.some((label) => label.caption?.includes(" · "))).toBe(false);
});

it("moves a frame's label west, clear of the compass rose, where it would sit on it", async () => {
  const { atlas } = await twins();
  const [, second] = atlas.frames;
  assert(second);
  // A long label over the eastern frame, which runs under the rose.
  const long: AtlasData = {
    ...atlas,
    frames: atlas.frames.map((frame) =>
      frame === second
        ? { ...frame, label: "a-workspace-with-a-very-long-name/product" }
        : frame
    ),
  };
  const box = compassBox(long);
  for (const pixels of [0.5, 1, 2]) {
    const view = { ...whole(long), pixelsPerUnit: pixels };
    const labels = paintInk(canvasFixture().canvas, { data: long, view });
    const label = labels.find((each) => each.frame === second.id);
    // Placed where it would be, if in view, and never over the rose.
    if (!label) {
      continue;
    }
    const clear =
      label.x + label.width / 2 <= box.west ||
      label.x - label.width / 2 >= box.east ||
      label.y <= box.north ||
      label.y - label.height >= box.south;
    expect(clear, `at ${pixels} px/unit`).toBe(true);
  }
  // At overview it is drawn, moved off its frame's middle.
  const overview = paintInk(canvasFixture().canvas, {
    data: long,
    view: whole(long),
  }).find((each) => each.frame === second.id);
  assert(overview);
  expect(overview.x + overview.width / 2).toBeLessThanOrEqual(box.west);
});
