import { describe, expect, it } from "vitest";
import { inkArea, type RasterImage } from "~/generation/raster/bitmap";
import { isolateLettering, twoLevel } from "~/reconstruction/isolation/isolate";
import { fixtureFace } from "../helpers/faces";
import {
  type Colour,
  degrade,
  plainPicture,
  setLettering,
} from "./helpers/lettering";

const WHITE: Colour = [255, 255, 255];
const BLACK: Colour = [0, 0, 0];

interface Block {
  readonly colour?: Colour;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** A plain picture with solid blocks on it. */
const blocks = (
  width: number,
  height: number,
  ground: Colour,
  ink: Colour,
  shapes: readonly Block[]
): RasterImage => {
  const data = new Uint8Array(width * height * 4);
  const paint = (x: number, y: number, [r, g, b]: Colour) =>
    data.set([r, g, b, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      paint(x, y, ground);
    }
  }
  for (const shape of shapes) {
    for (let y = shape.top; y < shape.top + shape.height; y += 1) {
      for (let x = shape.left; x < shape.left + shape.width; x += 1) {
        paint(x, y, shape.colour ?? ink);
      }
    }
  }
  return { data, height, width };
};

/** Three upright bars, 20 wide and 100 tall, 40 apart. */
const BARS: readonly Block[] = [0, 1, 2].map((index) => ({
  height: 100,
  left: 40 + index * 60,
  top: 40,
  width: 20,
}));

const lettersIn = (picture: RasterImage, options = {}) =>
  isolateLettering(picture, options).lines.flatMap((line) => line.letters);

describe("telling lettering from background", () => {
  it("takes the class along the border as background, whichever is darker", () => {
    const dark = isolateLettering(blocks(240, 180, WHITE, BLACK, BARS));
    expect(dark.separation.lettering).toBe("darker");
    expect(dark.separation.polarity).toBe("automatic");
    expect(dark.lines[0]?.letters).toHaveLength(3);
    const light = isolateLettering(blocks(240, 180, BLACK, WHITE, BARS));
    expect(light.separation.lettering).toBe("lighter");
    expect(light.lines[0]?.letters).toHaveLength(3);
    expect(inkArea(twoLevel(light.ink))).toBe(inkArea(twoLevel(dark.ink)));
  });

  it("lets a person override the polarity", () => {
    const picture = blocks(240, 180, WHITE, BLACK, BARS);
    const flipped = isolateLettering(picture, { lettering: "lighter" });
    expect(flipped.separation.polarity).toBe("given");
    // The white ground is now the lettering: one shape as large as the picture.
    expect(inkArea(twoLevel(flipped.ink))).toBeGreaterThan(240 * 180 * 0.8);
    expect(lettersIn(picture, { lettering: "lighter" })).toHaveLength(1);
  });

  it("separates by colour what tone cannot tell apart", () => {
    // A red and a green of the same lightness: (255, 140, 80) and
    // (60, 200, 60) both have a luminance of 160. With a little grain, as
    // any photograph has, tone has nothing to go on.
    const bars = setLettering([
      { emSize: 140, face: fixtureFace("lato"), text: "HIM" },
    ]);
    const picture = degrade(bars.ink, {
      blur: 0.8,
      ground: [60, 200, 60],
      ink: [255, 140, 80],
      noise: 8,
      seed: 11,
    });
    const byColour = isolateLettering(picture, { by: "colour" });
    expect(byColour.lines[0]?.letters).toHaveLength(3);
    expect(byColour.separation.separability).toBeGreaterThan(0.9);
    const byTone = isolateLettering(picture, { by: "tone" });
    expect(byTone.separation.separability).toBeLessThan(0.7);
    expect(byTone.lines.flatMap((line) => line.letters)).not.toHaveLength(3);
  });

  it("gives a clean two-level image: every pixel is 0 or 255", () => {
    const lettering = setLettering([
      { emSize: 100, face: fixtureFace("lato"), text: "Clean" },
    ]);
    const picture = degrade(lettering.ink, {
      blur: 1,
      ground: [230, 220, 200],
      ink: [60, 30, 30],
      noise: 10,
      seed: 3,
    });
    const { ink } = isolateLettering(picture);
    expect(new Set(twoLevel(ink).data)).toEqual(new Set([0, 255]));
  });
});

describe("specks", () => {
  it("are removed, and counted", () => {
    const specks: Block[] = [
      { height: 3, left: 10, top: 10, width: 3 },
      { height: 3, left: 200, top: 150, width: 4 },
      { height: 4, left: 120, top: 20, width: 3 },
    ];
    const found = isolateLettering(
      blocks(240, 180, WHITE, BLACK, [...BARS, ...specks])
    );
    expect(found.specksRemoved).toBe(3);
    expect(found.lines).toHaveLength(1);
    expect(found.lines[0]?.letters).toHaveLength(3);
    expect(inkArea(twoLevel(found.ink))).toBe(3 * 20 * 100);
  });
});

describe("joining the parts of one letter", () => {
  it("joins a dot to its stem and keeps neighbouring letters apart", () => {
    const lettering = setLettering([
      { emSize: 160, face: fixtureFace("lato"), text: "ijin" },
    ]);
    const letters = lettersIn(plainPicture(lettering.ink));
    expect(letters.map((letter) => letter.parts)).toEqual([2, 2, 2, 1]);
  });

  it("joins a stroke broken across, and a stroke cracked along the line within the reach given", () => {
    const brokenAcross: Block[] = [
      { height: 45, left: 40, top: 40, width: 20 },
      { height: 50, left: 40, top: 90, width: 20 },
    ];
    // A stem with an arm 20 thick, cracked through by two pixels.
    const brokenAlong: Block[] = [
      { height: 100, left: 100, top: 40, width: 20 },
      { height: 20, left: 120, top: 40, width: 20 },
      { height: 20, left: 142, top: 40, width: 20 },
    ];
    const whole: Block[] = [{ height: 100, left: 200, top: 40, width: 20 }];
    const picture = blocks(260, 180, WHITE, BLACK, [
      ...brokenAcross,
      ...brokenAlong,
      ...whole,
    ]);
    // Left to itself the join reaches a tenth of the stroke thickness, just
    // under two pixels here, so the crack parts the arm from its stem.
    expect(lettersIn(picture).map((letter) => letter.parts)).toEqual([
      2, 1, 1, 1,
    ]);
    // Told that a crack may be three pixels wide, it mends it.
    const mended = lettersIn(picture, { joinGap: 3 });
    expect(mended.map((letter) => letter.parts)).toEqual([2, 2, 1]);
    expect(mended.map((letter) => letter.box.right - letter.box.left)).toEqual([
      20, 62, 20,
    ]);
  });

  it("does not join letters whose boxes overlap when their ink does not touch", () => {
    // An L and a T pushed together as tight setting does: the bar of the T
    // hangs over the foot of the L, five pixels clear of it.
    const pair: Block[] = [
      { height: 100, left: 40, top: 40, width: 20 },
      { height: 20, left: 60, top: 120, width: 40 },
      { height: 20, left: 80, top: 40, width: 70 },
      { height: 75, left: 105, top: 60, width: 20 },
    ];
    const letters = lettersIn(blocks(220, 180, WHITE, BLACK, pair));
    expect(letters).toHaveLength(2);
    expect(letters[0]?.box.right).toBeGreaterThan(letters[1]?.box.left ?? 0);
  });

  it("marks a shape too wide to be one letter instead of counting it as one", () => {
    const fused: Block[] = [{ height: 100, left: 40, top: 40, width: 260 }];
    const [letter] = lettersIn(blocks(340, 180, WHITE, BLACK, [...fused]));
    expect(letter?.runTogether).toBe(true);
    expect(
      lettersIn(blocks(240, 180, WHITE, BLACK, BARS))[0]?.runTogether
    ).toBe(false);
  });
});

describe("lines of letters", () => {
  const lettering = setLettering([
    { emSize: 120, face: fixtureFace("lato"), text: "TOP LINE" },
    { emSize: 120, face: fixtureFace("lato"), text: "under it" },
  ]);
  const found = isolateLettering(plainPicture(lettering.ink));

  it("are found top to bottom, with letters left to right and words marked", () => {
    expect(found.lines.map((line) => line.letters.length)).toEqual([7, 7]);
    for (const line of found.lines) {
      const lefts = line.letters.map((letter) => letter.box.left);
      expect(lefts).toEqual(lefts.toSorted((a, b) => a - b));
      expect(line.letters.map((letter) => letter.spaceLeft)).toEqual(
        // TOP LINE and "under it": a word of three or five, then the rest.
        line === found.lines[0]
          ? [true, false, false, true, false, false, false]
          : [true, false, false, false, false, true, false]
      );
    }
  });

  it("have a baseline within a pixel of where the text was set", () => {
    for (const [index, line] of found.lines.entries()) {
      expect(
        Math.abs(line.baseline - (lettering.baselines[index] ?? 0))
      ).toBeLessThanOrEqual(1);
      expect(line.slope).toBe(0);
    }
  });

  it("measure capitals by their cap height and mixed case by its x-height", () => {
    const {
      capHeight = 0,
      unitsPerEm,
      xHeight = 0,
    } = fixtureFace("lato").description.metrics;
    const [capitals, mixed] = found.lines;
    expect(capitals?.body).toBe("cap-height");
    // Within two and a half pixels: a box is whole pixels, and round letters
    // reach a little past the line.
    expect(
      Math.abs((capitals?.bodyHeight ?? 0) - (120 * capHeight) / unitsPerEm)
    ).toBeLessThan(2.5);
    expect(mixed?.body).toBe("x-height");
    expect(
      Math.abs((mixed?.bodyHeight ?? 0) - (120 * xHeight) / unitsPerEm)
    ).toBeLessThan(2.5);
    expect(mixed?.ascent).toBeGreaterThan((mixed?.bodyHeight ?? 0) * 1.2);
  });

  it("can be read right to left", () => {
    const reversed = isolateLettering(plainPicture(lettering.ink), {
      direction: "rtl",
    });
    const lefts = reversed.lines[0]?.letters.map((letter) => letter.box.left);
    expect(lefts).toEqual(lefts?.toSorted((a, b) => b - a));
  });
});
