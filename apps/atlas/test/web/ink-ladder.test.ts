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
  it("meets each rung's floor on the darkest ground each mark is drawn on, at every named zoom", () => {
    // The sea ground is the darkest sea a line crosses, probed on screen.
    for (const pixels of Object.values(zooms)) {
      for (const mark of measured(pixels)) {
        expect(
          mark.contrast,
          `${mark.id} at ${pixels} px/unit`
        ).toBeGreaterThanOrEqual(rungFloor[mark.rung]);
      }
    }
  });

  it("orders the rungs selection, departure, file, label, tie, cell, coast, relief, sea", () => {
    expect(rungs).toEqual([
      "selection",
      "departure",
      "file",
      "label",
      "tie",
      "cell",
      "coast",
      "relief",
      "sea",
    ]);
    const floors = rungs.map((rung) => rungFloor[rung]);
    expect(floors).toEqual(floors.toSorted((a, b) => b - a));
  });

  it("keeps every mark lighter than every mark of the rungs above, on every ground, at every named zoom", () => {
    // An order between inks, not a ceiling: on a light shore a line can pass
    // the floor of the rung above and still read under every mark of it.
    for (const pixels of Object.values(zooms)) {
      for (const ground of Object.values(grounds)) {
        const marks = ladderMarks
          .filter((mark) => mark.alpha(pixels) > 0)
          .map((mark) => ({
            ...mark,
            on: contrast(mark.ink, mark.alpha(pixels), ground),
          }));
        for (const [rank, rung] of rungs.entries()) {
          const own = marks.filter((mark) => mark.rung === rung);
          if (!own.length) {
            continue;
          }
          const weakest = Math.min(...own.map((mark) => mark.on));
          for (const below of marks.filter(
            (mark) => rungs.indexOf(mark.rung) > rank
          )) {
            expect(
              below.on,
              `${below.id} under ${rung} on ${ground} at ${pixels} px/unit`
            ).toBeLessThan(weakest);
          }
        }
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

  it("gives departures a cue beside their magenta, the line darker than the ring and of its hue", () => {
    const ring = inkStyle("departure");
    const line = inkStyle("departure-line");
    expect(ring.cue).toBeTruthy();
    expect(line.cue).toBeTruthy();
    expect(line.dash.length).toBeGreaterThan(2);
    expect(line.hue).not.toBe(ring.hue);
    const apart = Math.abs(hue(line.hue) - hue(ring.hue));
    expect(Math.min(apart, 360 - apart)).toBeLessThan(5);
    // The line is clipped to the sea; on the sea it meets the departure rung.
    expect(contrast(line.hue, 1, grounds.sea)).toBeGreaterThanOrEqual(
      rungFloor.departure
    );
  });

  it("shares an ink across kinds only where the table means it to", () => {
    // A line and a fill, or a line and a text, in one ink read as one thing;
    // each pair here is that one thing on purpose.
    const intended: Record<string, string[]> = {
      "district pigment": [
        "district",
        "entered-outline",
        "responsibility-outline",
        "unresolved-outline",
      ],
      [inks.departureLine]: ["departure-bead", "departure-line"],
      [inks.grid]: ["grid", "grid-reference"],
      [inks.proximity]: [
        "proximity-apart",
        "proximity-bead",
        "proximity-close",
        "proximity-co-change",
      ],
      [inks.paper]: ["member-halo", "paper"],
      [inks.scale]: ["latitude-label", "latitude-scale"],
      [inks.selection]: [
        "exact-member",
        "selected-label",
        "selection",
        "selection-importers",
        "selection-imports",
      ],
    };
    const shared: Record<string, string[]> = {};
    for (const ink of new Set(inkTable.map((row) => row.hue))) {
      const rows = inkTable.filter((row) => row.hue === ink);
      if (new Set(rows.map((row) => row.kind)).size > 1) {
        shared[ink] = rows.map((row) => row.id).sort();
      }
    }
    expect(shared).toEqual(intended);
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

/** Linear-light RGB of an sRGB colour, 0 to 1. */
function linearRgb(hex: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return [r, g, b];
}

/**
 * Machado, Oliveira, and Fernandes (2009) at full severity, applied in linear
 * RGB: how each colour-vision deficiency sees a colour.
 */
const deficiencies = {
  deutan: [
    [0.367_322, 0.860_646, -0.227_968],
    [0.280_085, 0.672_501, 0.047_413],
    [-0.011_82, 0.042_94, 0.968_881],
  ],
  protan: [
    [0.152_286, 1.052_583, -0.204_868],
    [0.114_503, 0.786_281, 0.099_216],
    [-0.003_882, -0.048_116, 1.051_998],
  ],
  tritan: [
    [1.255_528, -0.076_749, -0.178_779],
    [-0.078_411, 0.930_809, 0.147_602],
    [0.004_733, 0.691_367, 0.3039],
  ],
} as const;
type Deficiency = keyof typeof deficiencies;

/** CIE L*a*b* of an sRGB colour, D65, as seen with a deficiency or without. */
function lab(hex: string, deficiency?: Deficiency): [number, number, number] {
  let [r, g, b] = linearRgb(hex);
  if (deficiency) {
    const [m0 = [], m1 = [], m2 = []] = deficiencies[deficiency];
    const row = (m: readonly number[]) =>
      Math.min(
        1,
        Math.max(0, (m[0] ?? 0) * r + (m[1] ?? 0) * g + (m[2] ?? 0) * b)
      );
    [r, g, b] = [row(m0), row(m1), row(m2)];
  }
  const f = (t: number) =>
    t > 216 / 24_389 ? Math.cbrt(t) : ((24_389 / 27) * t + 16) / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.950_47);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.088_83);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** ΔE76: the distance between two colours in L*a*b*; about 2.3 is a just-noticeable step. */
function deltaE(a: string, b: string, deficiency?: Deficiency): number {
  const [l1, a1, b1] = lab(a, deficiency);
  const [l2, a2, b2] = lab(b, deficiency);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe("file inks", () => {
  it("keeps every two file kinds at least 12 ΔE76 apart", () => {
    const files = Object.entries(inks.files);
    for (const [kind, ink] of files) {
      for (const [other, otherInk] of files) {
        if (kind < other) {
          expect(
            deltaE(ink, otherInk),
            `${kind} and ${other}`
          ).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it("keeps every two file inks 10 ΔE76 apart under deutan, protan, and tritan vision", () => {
    // At overview every file is the same dot, so every pair shares a shape
    // and the ink alone has to tell the kinds apart.
    const files = Object.entries(inks.files);
    for (const deficiency of Object.keys(deficiencies) as Deficiency[]) {
      for (const [kind, ink] of files) {
        for (const [other, otherInk] of files) {
          if (kind < other) {
            expect(
              deltaE(ink, otherInk, deficiency),
              `${kind} and ${other} under ${deficiency}`
            ).toBeGreaterThanOrEqual(10);
          }
        }
      }
    }
  });

  it("keeps the departure magenta 10 ΔE76 from every file ink and the selection, in every vision", () => {
    const others = { ...inks.files, selection: inks.selection };
    for (const deficiency of [
      undefined,
      ...(Object.keys(deficiencies) as Deficiency[]),
    ]) {
      for (const [name, ink] of Object.entries(others)) {
        for (const departure of [inks.departure, inks.departureLine]) {
          expect(
            deltaE(departure, ink, deficiency),
            `${departure} and ${name} under ${deficiency ?? "normal vision"}`
          ).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });

  it("keeps the proximity slate 10 ΔE76 from every ink it can lie beside, in every vision", () => {
    const beside = {
      ...inks.files,
      coastPen: inks.coastPen,
      departure: inks.departure,
      departureLine: inks.departureLine,
      enteredRing: inks.enteredRing,
      grid: inks.grid,
      hover: inks.hover,
      label: inks.label,
      labelCaption: inks.labelCaption,
      landContour: inks.landContour,
      marsh: inks.marsh,
      seaContour: inks.seaContour,
      selection: inks.selection,
      trade: inks.trade,
    };
    for (const deficiency of [
      undefined,
      ...(Object.keys(deficiencies) as Deficiency[]),
    ]) {
      for (const [name, ink] of Object.entries(beside)) {
        expect(
          deltaE(inks.proximity, ink, deficiency),
          `proximity and ${name} under ${deficiency ?? "normal vision"}`
        ).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("keeps the folder inks apart: names 10 ΔE76 from every label ink, cell lines from every ink they lie beside, in every vision", () => {
    const pairs: [string, string, string][] = [
      ["folder", inks.folder, inks.label],
      ["folder", inks.folder, inks.labelCaption],
      ...Object.entries({
        ...inks.files,
        coastPen: inks.coastPen,
        coastRule: inks.coastRule,
        folder: inks.folder,
        grid: inks.grid,
        label: inks.label,
        landContour: inks.landContour,
        marsh: inks.marsh,
        proximity: inks.proximity,
        seaContour: inks.seaContour,
      }).map(([name, ink]): [string, string, string] => [
        `folderLine and ${name}`,
        inks.folderLine,
        ink,
      ]),
    ];
    for (const deficiency of [
      undefined,
      ...(Object.keys(deficiencies) as Deficiency[]),
    ]) {
      for (const [name, a, b] of pairs) {
        expect(
          deltaE(a, b, deficiency),
          `${name} under ${deficiency ?? "normal vision"}`
        ).toBeGreaterThanOrEqual(10);
      }
    }
  });

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
