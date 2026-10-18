import { describe, expect, it } from "vitest";
import { filePen, speckRadius } from "../../src/web/data/bindings";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { fileInk, inks } from "../../src/web/ladder/ink-ladder";
import type { BelongingRegion } from "../../src/web/layout/belonging";
import {
  type FileMarkInputs,
  fileMarks,
} from "../../src/web/layout/file-marks";
import { alphaAt, type Glyph, sizeAt } from "../../src/web/layout/marks";

const file = (
  id: string,
  x: number,
  overrides: Partial<SpyglassFile> = {}
): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `src/${id}.ts`,
  x,
  y: 0,
  ...overrides,
});

const files = [
  file("source", -30),
  file("test", -20, { kind: "test" }),
  file("story", -10, { kind: "story" }),
  file("commons", 0, { fileRole: "commons" }),
  file("junction", 10, { fileRole: "junction" }),
  file("mixed", 20, { fileRole: "mixed" }),
  file("unknown", 30, { fileRole: "unknown" }),
];

const island: Territory = {
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files,
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: -40,
};

const inputs = (overrides: Partial<FileMarkInputs> = {}): FileMarkInputs => ({
  activeRegion: undefined,
  belonging: null,
  evidenceFiles: undefined,
  hasComposition: false,
  territories: [island],
  ...overrides,
});

const shapesOf = (marks: readonly Glyph[], id: string) =>
  marks
    .filter(
      (mark) => mark.x === island.x + (files.find((f) => f.id === id)?.x ?? 0)
    )
    .map((mark) => mark.shape);

describe("file marks", () => {
  it("drapes a speck and a mark on every file, both sized by the zoom through one function each", () => {
    const marks = fileMarks(inputs());
    expect(marks.every((mark) => mark.on === island)).toBe(true);
    const specks = marks.filter((mark) => mark.shape === "dot");
    expect(specks).toHaveLength(files.length);
    const [speck] = specks;
    expect(speck).toMatchObject({ colour: fileInk("source"), x: 70, y: -40 });
    expect(sizeAt(speck?.size ?? 0, 4)).toBeCloseTo(2 * speckRadius(4) * 4);
    // Specks hold until the marks come in, then give way to them.
    expect(alphaAt(speck?.alpha ?? 0, 1)).toBe(1);
    expect(alphaAt(speck?.alpha ?? 0, 5)).toBe(0);
    const [rect] = marks.filter((item) => item.shape === "file");
    expect(alphaAt(rect?.alpha ?? 0, 2)).toBe(0);
    expect(alphaAt(rect?.alpha ?? 0, 5)).toBe(1);
    // The file pen in CSS pixels: 1.8 units until it caps at 4.5 pixels.
    expect(sizeAt(rect?.size ?? 0, 2)).toBeCloseTo(filePen(2) * 2);
    expect(sizeAt(rect?.size ?? 0, 10)).toBeCloseTo(4.5);
    expect(new Set(specks.map((item) => item.size)).size).toBe(1);
    expect(new Set(marks.map((item) => item.alpha)).size).toBe(2);
  });

  it("marks each kind and role with its shape: a junction as a cross through a hollow square", () => {
    const marks = fileMarks(inputs()).filter((mark) => mark.shape !== "dot");
    expect(shapesOf(marks, "source")).toEqual(["file"]);
    expect(shapesOf(marks, "test")).toEqual(["testFile"]);
    expect(shapesOf(marks, "story")).toEqual(["halfDisc"]);
    expect(shapesOf(marks, "commons")).toEqual(["hoop"]);
    expect(shapesOf(marks, "junction")).toEqual(["cross", "frame"]);
    expect(shapesOf(marks, "mixed")).toEqual(["mixed"]);
    expect(shapesOf(marks, "unknown")).toEqual(["frame"]);
    // Every hollow shape takes the one-pixel pen; the filled ones none.
    for (const mark of marks) {
      const hollow = ["testFile", "hoop", "cross", "frame", "mixed"].includes(
        mark.shape
      );
      expect(mark.weight).toBe(hollow ? 1 : undefined);
    }
    // Shapes drawn at the pen's radius span twice the pen; a hollow square's edge straddles it.
    const hoop = marks.find((mark) => mark.shape === "hoop");
    const frame = marks.find((mark) => mark.shape === "frame");
    expect(sizeAt(hoop?.size ?? 0, 2)).toBeCloseTo(2 * filePen(2) * 2);
    expect(sizeAt(frame?.size ?? 0, 2)).toBeCloseTo(filePen(2) * 2 + 1);
    expect(
      marks.every(
        (mark) =>
          mark.colour ===
            fileInk(mark.shape === "halfDisc" ? "story" : "source") ||
          mark.colour === fileInk("test")
      )
    ).toBe(true);
  });

  it("dims every file outside an overlay's evidence to a share of the files' strength, sharing one alpha", () => {
    const marks = fileMarks(
      inputs({ evidenceFiles: new Set(["commons"]) })
    ).filter((mark) => mark.shape !== "dot");
    const kept = marks.find((mark) => mark.shape === "hoop");
    const dimmed = marks.filter((mark) => mark.shape !== "hoop");
    expect(alphaAt(kept?.alpha ?? 0, 5)).toBe(1);
    expect(new Set(dimmed.map((mark) => mark.alpha)).size).toBe(1);
    expect(alphaAt(dimmed[0]?.alpha ?? 0, 5)).toBeCloseTo(0.15);
    expect(alphaAt(dimmed[0]?.alpha ?? 0, 4)).toBeCloseTo(0.075);
    // An empty evidence set dims nothing.
    expect(
      new Set(
        fileMarks(inputs({ evidenceFiles: new Set() })).map(
          (mark) => mark.alpha
        )
      ).size
    ).toBe(2);
  });

  it("draws the selected group's exact members solid with a paper hairline, until a composition takes over", () => {
    const [member] = files;
    const own = fileMarks(
      inputs({
        belonging: { files: [member as SpyglassFile], territory: island },
      })
    ).slice(-2);
    expect(own[0]).toMatchObject({
      colour: inks.selection,
      shape: "square",
      size: 5,
      x: 70,
      y: -40,
    });
    expect(own[1]).toMatchObject({
      colour: inks.paper,
      shape: "frame",
      size: 6,
      weight: 1,
    });
    expect(alphaAt(own[0]?.alpha ?? 0, 7)).toBe(1);
    const region: BelongingRegion = {
      color: "#688c77",
      id: "region",
      label: "Region",
      members: [member as SpyglassFile],
      polygons: [],
      uncertain: false,
    };
    const grouped = fileMarks(
      inputs({
        activeRegion: region,
        belonging: { territory: island },
        hasComposition: true,
      })
    ).slice(-2);
    expect(grouped[0]).toMatchObject({
      colour: region.color,
      shape: "square",
      size: 3.5,
    });
    expect(alphaAt(grouped[0]?.alpha ?? 0, 6)).toBe(1);
    expect(alphaAt(grouped[0]?.alpha ?? 0, 7)).toBe(0);
    // A parent group with children names no exact members.
    const parent = fileMarks(
      inputs({
        activeRegion: { ...region, children: ["child"] },
        belonging: { territory: island },
      })
    );
    expect(parent.some((mark) => mark.shape === "square")).toBe(false);
  });
});
