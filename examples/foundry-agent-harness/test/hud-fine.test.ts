import { describe, expect, it } from "vitest";
import {
  fineGauge,
  finePortrait,
  fineStatTile,
  fineStatTileArt,
  fineStepStrip,
  fineStepStripArt,
} from "@/model/fine-parts";
import { hudGeometry } from "@/model/hud-art";
import { fineHud, fineHudArt } from "@/model/hud-fine";
import { tallNumerals } from "@/model/numerals";
import { hud, tones } from "@/model/palette";
import {
  type ArtRow,
  clashes,
  createFineCanvas,
  fill,
  rasterizeFine,
} from "@/model/pixels";
import { encodeCell, sextant } from "@/model/sextants";
import type { Step } from "@/model/steps";

const BLACK = "#000000";
const WHITE = "#ffffff";
const RED = "#ff0000";
const sizes = [
  { height: 34, width: 120 },
  { height: 30, width: 96 },
  { height: 24, width: 80 },
];
const parts = [
  { rows: 9 },
  { meta: "160k tok", rows: 7, title: "VITALS" },
  { meta: "11 calls", rows: 3, title: "ARSENAL" },
  { grow: true, meta: "2 slots", title: "LOADOUT" },
];
const steps: readonly Step[] = [
  { label: "Locate package.json", state: "done" },
  { label: "Identify scripts", state: "done" },
  { label: "Check setup", state: "active" },
  { label: "Summarize", state: "pending" },
];

function widths(rows: readonly ArtRow[]): number[] {
  return rows.map((row) =>
    row.runs.reduce((sum, run) => sum + [...run.text].length, 0)
  );
}

function textOf(rows: readonly ArtRow[]): string[] {
  return rows.map((row) => row.runs.map((run) => run.text).join(""));
}

describe("the sextant table", () => {
  it("follows the code points and reuses four older glyphs", () => {
    expect([0, 1, 2, 3, 20, 21, 22, 41, 42, 43, 62, 63].map(sextant)).toEqual([
      " ",
      "\u{1FB00}",
      "\u{1FB01}",
      "\u{1FB02}",
      "\u{1FB13}",
      "▌",
      "\u{1FB14}",
      "\u{1FB27}",
      "▐",
      "\u{1FB28}",
      "\u{1FB3B}",
      "█",
    ]);
  });

  it("gives every pattern its own single glyph", () => {
    const glyphs = Array.from({ length: 64 }, (_, pattern) => sextant(pattern));
    expect(new Set(glyphs).size).toBe(64);
    expect(glyphs.every((glyph) => [...glyph].length === 1)).toBe(true);
  });
});

describe("the cell encoder", () => {
  it("draws one colour as a blank cell", () => {
    expect(encodeCell(Array.from({ length: 6 }, () => RED))).toEqual({
      bg: RED,
      char: " ",
      clash: false,
      fg: RED,
    });
  });

  it("puts the darker colour behind, whichever is more common", () => {
    expect(encodeCell([WHITE, BLACK, BLACK, BLACK, BLACK, BLACK])).toEqual({
      bg: BLACK,
      char: "\u{1FB00}",
      clash: false,
      fg: WHITE,
    });
    expect(encodeCell([BLACK, WHITE, WHITE, WHITE, WHITE, WHITE])).toEqual({
      bg: BLACK,
      char: "\u{1FB3B}",
      clash: false,
      fg: WHITE,
    });
  });

  it("uses the half blocks for a full column", () => {
    expect(encodeCell([WHITE, BLACK, WHITE, BLACK, WHITE, BLACK]).char).toBe(
      "▌"
    );
    expect(encodeCell([BLACK, WHITE, BLACK, WHITE, BLACK, WHITE]).char).toBe(
      "▐"
    );
  });

  it("keeps the two commonest colours and folds a third into the nearer", () => {
    expect(encodeCell([RED, RED, RED, BLACK, BLACK, "#200000"])).toEqual({
      bg: BLACK,
      char: "\u{1FB06}",
      clash: true,
      fg: RED,
    });
    expect(encodeCell([RED, RED, RED, BLACK, BLACK, "#e00000"]).char).toBe(
      "\u{1FB25}"
    );
  });

  it("breaks a tie between colours by which comes first", () => {
    const first = encodeCell([RED, WHITE, BLACK, RED, WHITE, BLACK]);
    expect([first.bg, first.fg, first.clash]).toEqual([RED, WHITE, true]);
  });
});

describe("the fine canvas", () => {
  it("has six pixels to a cell and merges cells of the same colours", () => {
    const canvas = createFineCanvas(3, 1, BLACK);
    fill(canvas, { height: 1, width: 4, x: 0, y: 0 }, WHITE);
    expect(canvas.map((row) => row.length)).toEqual([6, 6, 6]);
    expect(rasterizeFine(canvas)).toEqual([
      {
        key: "y0",
        runs: [
          {
            bg: BLACK,
            bold: false,
            fg: WHITE,
            key: "x0",
            text: "\u{1FB02}\u{1FB02} ",
          },
        ],
      },
    ]);
    expect(clashes(canvas)).toBe(0);
  });

  it("counts the cells that hold more than two colours", () => {
    const canvas = createFineCanvas(2, 1, BLACK);
    fill(canvas, { height: 1, width: 1, x: 0, y: 0 }, WHITE);
    fill(canvas, { height: 1, width: 1, x: 1, y: 0 }, RED);
    expect(clashes(canvas)).toBe(1);
  });
});

describe("the tall numerals", () => {
  it("are six pixels wide and nine high, each different", () => {
    const glyphs = tallNumerals("0123456789");
    expect(glyphs).toHaveLength(10);
    for (const glyph of glyphs) {
      expect(glyph.map((line) => line.length)).toEqual(
        Array.from({ length: 9 }, () => 6)
      );
    }
    expect(new Set(glyphs.map((glyph) => glyph.join("\n"))).size).toBe(10);
  });

  it("skip anything that is not a digit", () => {
    expect(tallNumerals("7%")).toHaveLength(1);
  });
});

describe("the fine art", () => {
  it.each(sizes)(
    "draws the hud at $width by $height with no colour clash",
    (size) => {
      const art = fineHud(size, parts);
      expect(clashes(art.canvas)).toBe(0);
      const rows = fineHudArt(size, parts);
      expect(widths(rows)).toEqual(
        Array.from({ length: size.height }, () => size.width)
      );
      const text = textOf(rows).join("\n");
      for (const title of ["VITALS", "ARSENAL", "LOADOUT", "160k tok", ">_"]) {
        expect(text).toContain(title);
      }
    }
  );

  it("leaves the conversation flat for text", () => {
    const size = { height: 34, width: 120 };
    const { main } = hudGeometry(size, parts);
    const row = textOf(fineHudArt(size, parts))[main.y + 5] ?? "";
    expect(
      [...row]
        .slice(main.x, main.x + main.width)
        .join("")
        .trim()
    ).toBe("");
  });

  it("draws the step strip at any width with no colour clash", () => {
    for (const width of [20, 49, 61, 81]) {
      expect(clashes(fineStepStrip(steps, width).canvas)).toBe(0);
      expect(widths(fineStepStripArt(steps, width))).toEqual([
        width,
        width,
        width,
      ]);
    }
    expect(textOf(fineStepStripArt(steps, 81))[1]).toContain("▶ 3 Check setup");
    expect(clashes(fineStepStrip([], 30).canvas)).toBe(0);
  });

  it("draws every percentage with no colour clash", () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      const tile = fineStatTile({
        label: "CONTEXT",
        level: percent / 100,
        tone: tones.amber,
        width: 22,
      });
      expect(clashes(tile.canvas)).toBe(0);
      expect(clashes(fineGauge(24, percent / 100, tones.red).canvas)).toBe(0);
    }
  });

  it("sets the caption, note and percent sign beside the figure", () => {
    const rows = textOf(
      fineStatTileArt({
        detail: "of 200k",
        label: "CONTEXT",
        level: 0.64,
        tone: tones.amber,
        width: 22,
      })
    );
    expect(rows.map((row) => [...row].length)).toEqual([22, 22, 22]);
    expect([...(rows[0] ?? "")].slice(11).join("").trim()).toBe("CONTEXT");
    expect([...(rows[1] ?? "")].slice(11).join("").trim()).toBe("of 200k");
    expect([...(rows[2] ?? "")][7]).toBe("%");
    const full = textOf(
      fineStatTileArt({
        label: "STAMINA",
        level: 1,
        tone: tones.green,
        width: 22,
      })
    );
    expect(full.join("")).not.toContain("%");
  });

  it("draws the portrait bay in two colours a cell at any height", () => {
    for (const rows of [5, 7, 9, 11, 14]) {
      const art = finePortrait({ caption: "holding steady", rows, width: 24 });
      expect(clashes(art.canvas)).toBe(0);
      expect(art.canvas).toHaveLength(rows * 3);
      expect(art.labels.at(-1)).toMatchObject({
        bg: hud.screen,
        text: " holding steady ",
        y: rows - 1,
      });
    }
  });
});
