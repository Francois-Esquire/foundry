import { describe, expect, it } from "vitest";
import { hudArt, hudGeometry } from "@/model/hud-art";
import { drawNumerals, numeralWidth } from "@/model/numerals";
import { hud, tones } from "@/model/palette";
import {
  type ArtRow,
  createCanvas,
  etch,
  fill,
  rasterize,
  stamp,
} from "@/model/pixels";
import { portraitArt } from "@/model/portrait";
import { fitSteps, type Step, stepStripArt } from "@/model/steps";
import { gaugeArt, statTileArt } from "@/model/vitals";

const parts = [
  { rows: 9 },
  { meta: "160k tok", rows: 5, title: "VITALS" },
  { rows: 3, title: "ARSENAL" },
  { grow: true, title: "LOADOUT" },
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

function textOf(rows: readonly ArtRow[]): string {
  return rows.map((row) => row.runs.map((run) => run.text).join("")).join("\n");
}

describe("the pixel canvas", () => {
  it("draws two pixels to a cell and merges equal neighbours", () => {
    const canvas = createCanvas(4, 1, () => "#000000");
    fill(canvas, { height: 1, width: 2, x: 0, y: 0 }, "#ffffff");
    expect(rasterize(canvas)).toEqual([
      {
        key: "y0",
        runs: [
          {
            bg: "#000000",
            bold: false,
            fg: "#ffffff",
            key: "x0",
            text: "▀▀  ",
          },
        ],
      },
    ]);
  });

  it("splits runs where the colours change", () => {
    const canvas = createCanvas(3, 1, () => "#000000");
    fill(canvas, { height: 2, width: 1, x: 1, y: 0 }, "#ff0000");
    expect(rasterize(canvas)[0]?.runs.map((run) => [run.key, run.bg])).toEqual([
      ["x0", "#000000"],
      ["x1", "#ff0000"],
      ["x2", "#000000"],
    ]);
  });

  it("ignores pixels outside the canvas", () => {
    const canvas = createCanvas(2, 1, () => "#000000");
    fill(canvas, { height: 9, width: 9, x: -3, y: -3 }, "#111111");
    stamp(canvas, 1, 1, ["##", "##"], { "#": "#222222" });
    expect(canvas).toEqual([
      ["#111111", "#111111"],
      ["#111111", "#222222"],
    ]);
  });

  it("writes labels over the pixels and clips them", () => {
    const canvas = createCanvas(4, 1, () => "#000000");
    const [row] = rasterize(canvas, [
      { bg: "#333333", bold: true, fg: "#ffffff", text: "abc", x: 2, y: 0 },
    ]);
    expect(row?.runs).toEqual([
      { bg: "#000000", bold: false, fg: "#000000", key: "x0", text: "  " },
      { bg: "#333333", bold: true, fg: "#ffffff", key: "x2", text: "ab" },
    ]);
  });

  it("etches a mark on the pixel colour under it", () => {
    const canvas = createCanvas(3, 2, (x) => (x === 1 ? "#444444" : "#000000"));
    expect(etch(canvas, { width: 2, x: 1, y: 1 }, "▔", "#ffffff")).toEqual([
      { bg: "#444444", fg: "#ffffff", text: "▔", x: 1, y: 1 },
      { bg: "#000000", fg: "#ffffff", text: "▔", x: 2, y: 1 },
    ]);
    expect(etch(canvas, { x: 7, y: 0 }, "▔", "#ffffff")).toEqual([]);
  });
});

describe("the numerals", () => {
  it("measure digits with a narrow one", () => {
    expect(numeralWidth("71")).toBe(8);
    expect(numeralWidth("64")).toBe(11);
    expect(numeralWidth("100")).toBe(14);
    expect(numeralWidth("")).toBe(0);
  });

  it("draw a ramp over the unlit segments", () => {
    const canvas = createCanvas(5, 3, () => ".");
    drawNumerals(canvas, { x: 0, y: 0 }, "4", ["a", "b", "c", "d", "e"], "o");
    expect(canvas.map((row) => row.join(""))).toEqual([
      "aaoaa",
      "bb.bb",
      "ccccc",
      "oo.dd",
      "oooee",
      ".....",
    ]);
  });
});

describe("the steps", () => {
  it("names every step when there is room", () => {
    expect(fitSteps(steps, 90).map((chip) => chip.text)).toEqual([
      " ✓ 1 Locate package.json ",
      " ✓ 2 Identify scripts ",
      " ▶ 3 Check setup ",
      " 4 Summarize ",
    ]);
  });

  it("shrinks done steps first, then pending ones, then all", () => {
    expect(fitSteps(steps, 50).map((chip) => chip.text)).toEqual([
      " ✓ 1 ",
      " ✓ 2 ",
      " ▶ 3 Check setup ",
      " 4 Summarize ",
    ]);
    expect(fitSteps(steps, 40).map((chip) => chip.text)).toEqual([
      " ✓ 1 ",
      " ✓ 2 ",
      " ▶ 3 Check setup ",
      " 4 ",
    ]);
    expect(fitSteps(steps, 10).map((chip) => chip.text)).toEqual([
      " ✓ 1 ",
      " ✓ 2 ",
      " ▶ 3 ",
      " 4 ",
    ]);
  });

  it("draws a strip three rows high and exactly as wide as asked", () => {
    for (const width of [20, 51, 83]) {
      const rows = stepStripArt(steps, width);
      expect(widths(rows)).toEqual([width, width, width]);
    }
    expect(textOf(stepStripArt(steps, 83))).toContain("▶ 3 Check setup");
    expect(widths(stepStripArt([], 30))).toEqual([30, 30, 30]);
  });
});

describe("the vitals", () => {
  it("lights the gauge to its level with a bright tip", () => {
    const [row] = gaugeArt(10, 0.64, tones.red);
    expect(row?.runs.map((run) => [run.fg, run.text.length])).toEqual([
      [tones.red.lit, 5],
      [tones.red.glow, 1],
      [hud.iron[2], 4],
    ]);
  });

  it("clamps the gauge", () => {
    expect(gaugeArt(4, 7, tones.red)[0]?.runs.at(-1)?.fg).toBe(tones.red.glow);
    expect(gaugeArt(4, -1, tones.red)[0]?.runs.map((run) => run.fg)).toEqual([
      hud.iron[2],
    ]);
  });

  it("draws a tile three rows high with its figure, caption and gauge", () => {
    const rows = statTileArt({
      detail: "of 200k",
      label: "CONTEXT",
      level: 0.64,
      tone: tones.amber,
      width: 22,
    });
    expect(widths(rows)).toEqual([22, 22, 22]);
    const text = textOf(rows).split("\n");
    expect(text[0]?.slice(14)).toBe("CONTEXT ");
    expect(text[1]?.slice(14)).toBe("of 200k ");
    expect(text[2]?.slice(12)).toBe("% ▊▊▊▊▊▊▊▊");
  });

  it("drops the percent sign and narrows the side for three digits", () => {
    const rows = statTileArt({
      label: "STAMINA",
      level: 1,
      tone: tones.green,
      width: 22,
    });
    const text = textOf(rows).split("\n");
    expect(textOf(rows)).not.toContain("%");
    expect(text[0]?.slice(15)).toBe("STAMINA");
    expect(text[2]?.slice(15)).toBe("▊▊▊▊▊▊▊");
  });
});

describe("the portrait bay", () => {
  it("is exactly the size asked and carries the caption", () => {
    for (const rows of [7, 9, 11]) {
      const art = portraitArt({ caption: "holding steady", rows, width: 24 });
      expect(widths(art)).toEqual(Array.from({ length: rows }, () => 24));
      expect(textOf(art)).toContain("holding steady");
    }
  });
});

describe("the hud geometry", () => {
  it("gives two-row heads and a wider edge to a large screen", () => {
    const geometry = hudGeometry({ height: 34, width: 120 }, parts);
    expect(geometry.dense).toBe(false);
    expect(geometry.rail).toBe(32);
    expect(geometry.parts.map((part) => part.body)).toEqual([
      { height: 9, width: 22, x: 5, y: 2 },
      { height: 5, width: 22, x: 5, y: 13 },
      { height: 3, width: 22, x: 5, y: 20 },
      { height: 8, width: 22, x: 5, y: 25 },
    ]);
    expect(geometry.steps).toEqual({ height: 3, width: 81, x: 35, y: 0 });
    expect(geometry.main).toEqual({ height: 27, width: 77, x: 37, y: 3 });
    expect(geometry.goal).toEqual({ height: 1, width: 71, x: 40, y: 31 });
    expect(geometry.hints).toEqual({ height: 1, width: 81, x: 35, y: 33 });
  });

  it("goes dense at 80 by 24 and still fits every part", () => {
    const geometry = hudGeometry({ height: 24, width: 80 }, parts);
    expect(geometry.dense).toBe(true);
    expect(geometry.rail).toBe(28);
    expect(
      geometry.parts.map((part) => [part.head.y, part.body.height])
    ).toEqual([
      [0, 9],
      [10, 5],
      [16, 3],
      [20, 2],
    ]);
    expect(geometry.main.height).toBe(17);
  });

  it("keeps a part list that is too long inside the screen", () => {
    const geometry = hudGeometry({ height: 24, width: 80 }, [
      ...parts,
      { rows: 30, title: "EXTRA" },
    ]);
    for (const part of geometry.parts) {
      expect(part.body.y + part.body.height).toBeLessThanOrEqual(24);
    }
  });
});

describe("the hud art", () => {
  it.each([
    [120, 34],
    [96, 30],
    [80, 24],
  ])(
    "covers every cell at %i by %i and engraves the titles",
    (width, height) => {
      const rows = hudArt({ height, width }, parts);
      expect(widths(rows)).toEqual(Array.from({ length: height }, () => width));
      const text = textOf(rows);
      for (const title of ["VITALS", "ARSENAL", "LOADOUT", "160k tok", ">_"]) {
        expect(text).toContain(title);
      }
    }
  );

  it("leaves the content regions flat for text", () => {
    const size = { height: 34, width: 120 };
    const rows = hudArt(size, parts);
    const { main } = hudGeometry(size, parts);
    const row = rows[main.y + 5];
    let x = 0;
    const inside = (row?.runs ?? []).filter((run) => {
      const start = x;
      x += [...run.text].length;
      return start < main.x + main.width && x > main.x;
    });
    expect(inside.map((run) => [run.bg, run.text.trim()])).toEqual([
      [hud.screen, ""],
    ]);
  });
});
