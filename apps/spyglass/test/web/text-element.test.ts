// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { inks } from "../../src/web/ladder/ink-ladder";
import type { TextMetrics } from "../../src/web/scene/labels/measure";
import {
  keyedElements,
  letter,
  setText,
  squash,
} from "../../src/web/scene/labels/text-element";
import { recordStyleWrites } from "../helpers/style-writes";

it("keeps an entry per key across reconciles, retires the keys no longer shown, and visits each in order", () => {
  const made: string[] = [];
  const retired: string[] = [];
  const entries = keyedElements<string, { id: string; n: number }, string>({
    create: (value) => {
      made.push(value.id);
      return `entry ${value.id}`;
    },
    key: (value) => value.id,
    retire: (entry) => retired.push(entry),
  });
  const visited: [string, number][] = [];
  entries.reconcile(
    [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ],
    (entry, value) => visited.push([entry, value.n])
  );
  expect(made).toEqual(["a", "b"]);
  expect(visited).toEqual([
    ["entry a", 1],
    ["entry b", 2],
  ]);
  expect(entries.size).toBe(2);
  // A kept key keeps its entry; a new one is made; the missing one is retired.
  entries.reconcile(
    [
      { id: "c", n: 3 },
      { id: "a", n: 4 },
    ],
    () => undefined
  );
  expect(made).toEqual(["a", "b", "c"]);
  expect(retired).toEqual(["entry b"]);
  expect(entries.get("a")).toBe("entry a");
  expect(entries.get("b")).toBeUndefined();
  expect(entries.size).toBe(2);
});

it("letters an element once, and again only when its font, ink or halo changes", () => {
  const element = document.createElement("span");
  const writes = recordStyleWrites(element);
  const font = { face: "SpyglassBody", letterSpacing: 0.1 } as const;
  letter(element, font, inks.label, 3);
  expect(element.style.fontFamily).toBe("SpyglassBody, sans-serif");
  expect(element.style.letterSpacing).toBe("0.1em");
  expect(element.style.color).toBe(inks.label);
  expect(writes).toEqual([
    "fontFamily",
    "fontStyle",
    "letterSpacing",
    "color",
    "webkitTextStroke",
  ]);
  // The same lettering, from an equal font object: nothing written.
  writes.length = 0;
  letter(element, { ...font }, inks.label, 3);
  expect(writes).toEqual([]);
  // A new ink: written again, in full.
  letter(element, font, inks.selection, 6);
  expect(writes).toHaveLength(5);
  expect(element.style.color).toBe(inks.selection);
});

/** A measure every test can predict: 0.5 em a character, the baseline 0.8 em down. */
const metrics: TextMetrics = {
  baseline: () => 0.8,
  dispose: () => undefined,
  measure: (text) => text.length * 0.5,
};

/** A frame on a one-to-one screen, which no test projects through. */
const frame = {
  pixelRatio: 1,
  pixels: 1,
  screen: () => ({ x: 0, y: 0 }),
  state: {} as never,
  view: { height: 1, pixelsPerUnit: 1, width: 1, x: 0, y: 0 },
};

it("sets a text at its size, centred on a point, its baseline or its middle on it, snapped to the device's pixels", () => {
  const element = document.createElement("span");
  const font = { face: "Georgia", letterSpacing: 0 } as const;
  // Four characters at 10 px: 20 px wide; the baseline 8 px down, squashed.
  setText(
    element,
    { align: "baseline", at: { x: 100, y: 50 }, font, size: 10, text: "name" },
    frame,
    metrics
  );
  expect(element.style.fontSize).toBe("10px");
  expect(element.style.transform).toBe(
    `translate(90px, ${Math.round(50 - squash * 8)}px) scaleY(${squash})`
  );
  // The middle on the point: half the size down, squashed.
  setText(
    element,
    { align: "middle", at: { x: 100, y: 50 }, font, size: 10, text: "name" },
    frame,
    metrics
  );
  expect(element.style.transform).toBe(
    `translate(90px, ${Math.round(50 - squash * 5)}px) scaleY(${squash})`
  );
  // A wider box, as a name's over its caption is, centres the box.
  setText(
    element,
    {
      align: "baseline",
      at: { x: 100, y: 50 },
      font,
      size: 10,
      text: "name",
      width: 40,
    },
    { ...frame, pixelRatio: 2 },
    metrics
  );
  expect(element.style.transform).toBe(
    `translate(80px, ${Math.round((50 - squash * 8) * 2) / 2}px) scaleY(${squash})`
  );
});
