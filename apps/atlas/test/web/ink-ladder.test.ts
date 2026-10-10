import { describe, expect, it } from "vitest";
import {
  contrast,
  fileInk,
  grounds,
  inkAlpha,
  inkStyle,
  inks,
  inkTable,
  ladderMarks,
  rungFloor,
  rungs,
  zooms,
} from "../../src/web/scene/ink-ladder";

/** Each drawn mark's contrast with its ground at a zoom. */
function measured(pixels: number) {
  return ladderMarks
    .map((mark) => ({
      ...mark,
      contrast: contrast(mark.ink, mark.alpha(pixels), grounds[mark.ground]),
    }))
    .filter((mark) => mark.alpha(pixels) > 0);
}

describe("the ink ladder", () => {
  it("keeps every mark within its rung at every named zoom", () => {
    for (const pixels of Object.values(zooms)) {
      for (const mark of measured(pixels)) {
        const rank = rungs.indexOf(mark.rung);
        const above = rungs[rank - 1];
        expect(
          mark.contrast,
          `${mark.id} at ${pixels} px/unit`
        ).toBeGreaterThanOrEqual(rungFloor[mark.rung]);
        if (above) {
          expect(mark.contrast, `${mark.id} at ${pixels} px/unit`).toBeLessThan(
            rungFloor[above]
          );
        }
      }
    }
  });

  it("orders the rungs selection, departure, file, label, coast, relief, sea", () => {
    expect(rungs).toEqual([
      "selection",
      "departure",
      "file",
      "label",
      "coast",
      "relief",
      "sea",
    ]);
    const floors = rungs.map((rung) => rungFloor[rung]);
    expect(floors).toEqual(floors.toSorted((a, b) => b - a));
    for (const pixels of Object.values(zooms)) {
      const marks = measured(pixels);
      for (const [rank, rung] of rungs.entries()) {
        const weakest = Math.min(
          ...marks.filter((mark) => mark.rung === rung).map((m) => m.contrast)
        );
        const strongestBelow = Math.max(
          1,
          ...marks
            .filter((mark) => rungs.indexOf(mark.rung) > rank)
            .map((mark) => mark.contrast)
        );
        expect(weakest).toBeGreaterThan(strongestBelow);
      }
    }
  });

  it("keeps relief lighter than any file mark, at its steepest", () => {
    const relief = ladderMarks.find((mark) => mark.id === "relief");
    const files = ladderMarks.filter((mark) => mark.rung === "file");
    for (const pixels of Object.values(zooms)) {
      const shade = contrast(
        relief?.ink ?? "",
        relief?.alpha(pixels) ?? 1,
        grounds.land
      );
      for (const file of files.filter((mark) => mark.alpha(pixels) > 0)) {
        expect(shade).toBeLessThan(
          contrast(file.ink, file.alpha(pixels), grounds.land)
        );
      }
    }
  });
});

describe("the ink table", () => {
  it("gives every meaning of one kind its own hue, dash, and weight", () => {
    const styles = inkTable.map(
      (row) => `${row.kind}|${row.hue}|${row.dash.join(",")}|${row.weight}`
    );
    expect(new Set(styles).size).toBe(styles.length);
    // Rows of one kind, hue, and dash must differ by at least a pixel of weight.
    for (const a of inkTable) {
      for (const b of inkTable) {
        if (
          a !== b &&
          a.kind === b.kind &&
          a.hue === b.hue &&
          a.dash.join(",") === b.dash.join(",")
        ) {
          expect(
            Math.abs(a.weight - b.weight),
            `${a.id} and ${b.id}`
          ).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(new Set(inkTable.map((row) => row.id)).size).toBe(inkTable.length);
  });

  it("keeps hover readable over the coast rule and apart from the selection", () => {
    // Both at 3:1 is impossible: the rule is light and the selection near
    // black, so hover sits between them, at least 2.3:1 from each.
    expect(
      contrast(inks.hover, inkAlpha.hoverLine, inks.coastRule)
    ).toBeGreaterThanOrEqual(2.3);
    expect(contrast(inks.hover, 1, inks.selection)).toBeGreaterThanOrEqual(2.3);
    expect(inkStyle("hover").hue).not.toBe(inkStyle("selection").hue);
  });

  it("gives departures a cue beside their magenta, and draws none before 4.2b", () => {
    const departure = inkStyle("departure");
    expect(departure.cue).toBeTruthy();
    expect(departure.dash.length).toBeGreaterThan(2);
    expect(departure.drawn).toBe(false);
  });

  it("names every row a painter asks for", () => {
    expect(() => inkStyle("no such row")).toThrow(
      'The ink table has no row "no such row".'
    );
  });
});

/** A colour's hue angle, 0 to 360. */
function hue(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255
  );
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (!span) {
    return 0;
  }
  let raw = (r - g) / span + 4;
  if (max === r) {
    raw = (g - b) / span;
  } else if (max === g) {
    raw = (b - r) / span + 2;
  }
  return (raw * 60 + 360) % 360;
}

describe("file inks", () => {
  it("leaves magenta to departures", () => {
    for (const ink of Object.values(inks.files)) {
      const apart = Math.abs(hue(ink) - hue(inks.departure));
      expect(Math.min(apart, 360 - apart)).toBeGreaterThan(60);
    }
  });

  it("distinguishes the canonical kinds and gives unknown kinds the neutral ink", () => {
    const kinds = ["source", "test", "story", "config", "other"];
    expect(new Set(kinds.map(fileInk)).size).toBe(5);
    expect(fileInk("unknown")).toBe(fileInk("other"));
  });
});
