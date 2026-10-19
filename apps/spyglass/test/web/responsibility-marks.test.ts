import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import {
  alphaAt,
  type Fill,
  type Glyph,
  type Mark,
  type Stroke,
} from "../../src/web/layout/marks";
import type { ResponsibilityOverlay } from "../../src/web/layout/responsibility-focus";
import {
  responsibilityFollowsZoom,
  responsibilityMarks,
} from "../../src/web/layout/responsibility-marks";

const file = (id: string, x: number, y: number): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `src/${id}.ts`,
  x,
  y,
});

/** A square ring from −half to half. */
const box = (half: number): [number, number][] => [
  [-half, -half],
  [half, -half],
  [half, half],
  [-half, half],
  [-half, -half],
];

const island: Territory = {
  analyzed: true,
  coast: [[box(50)]],
  fileRoles: undefined,
  files: [file("one", 0, 0), file("two", 30, 0), file("three", 0, 30)],
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

const bare: ResponsibilityOverlay = {
  links: [],
  members: [],
  pathDisagreement: [],
  related: [],
  territoryId: "island",
  totalLinks: 0,
  unresolved: [],
};

const fills = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Fill => mark.kind === "fill");
const strokes = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Stroke => mark.kind === "stroke");
const glyphs = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Glyph => mark.kind === "glyph");

describe("responsibility marks", () => {
  it("rings members and related files at the files' detail, notches a disagreement and diamonds an unresolved file", () => {
    const overlay: ResponsibilityOverlay = {
      ...bare,
      members: ["one"],
      pathDisagreement: ["one"],
      related: ["two"],
      unresolved: ["three"],
    };
    const marks = responsibilityMarks({
      overlay,
      pixels: 4,
      territory: island,
    });
    expect(marks.every((mark) => mark.on === island)).toBe(true);
    const [related, member, notch] = glyphs(marks);
    expect(related).toMatchObject({
      colour: inkStyle("inspection-related").hue,
      shape: "hoop",
      size: 5,
      weight: inkStyle("inspection-related").weight,
      x: 130,
      y: -40,
    });
    expect(member).toMatchObject({
      colour: inkStyle("inspection-focus").hue,
      shape: "hoop",
      size: 7,
      x: 100,
    });
    expect(notch).toMatchObject({
      colour: inks.inspectionWarning,
      shape: "notch",
      size: 8,
      weight: inkStyle("inspection-notch").weight,
    });
    const [diamond] = strokes(marks);
    const unresolved = inkStyle("inspection-unresolved");
    expect(diamond).toMatchObject({
      colour: inks.inspectionWarning,
      dash: unresolved.dash,
      width: unresolved.weight,
    });
    // Six pixels at four a unit: 1.5 units each way, closed on its north.
    expect(diamond?.points).toEqual([
      100, -11.5, 101.5, -10, 100, -8.5, 98.5, -10, 100, -11.5,
    ]);
    // Everything shows with the file marks.
    expect(alphaAt(member?.alpha ?? 0, 3)).toBe(0);
    expect(alphaAt(member?.alpha ?? 0, 5)).toBe(1);
    expect(diamond?.alpha).toBe(member?.alpha);
  });

  it("dots a hint's arc and dashes a link between evidence files", () => {
    const overlay: ResponsibilityOverlay = {
      ...bare,
      hints: ["two"],
      links: [{ source: "one", target: "two" }],
    };
    const [hint, link] = strokes(
      responsibilityMarks({ overlay, pixels: 5, territory: island })
    );
    const hintPen = inkStyle("inspection-hint");
    expect(hint).toMatchObject({
      alpha: 1,
      colour: hintPen.hue,
      dash: hintPen.dash,
      width: hintPen.weight,
    });
    // A one-unit radius at five pixels a unit, from 0.3 to 1.6π, open to the north-east.
    expect(hint?.points).toHaveLength(34);
    expect(hint?.points.slice(0, 2)).toEqual([
      130 + Math.cos(0.3),
      -40 + Math.sin(0.3),
    ]);
    const linkPen = inkStyle("inspection-link");
    expect(link).toMatchObject({
      alpha: inkAlpha.inspectionLink,
      colour: linkPen.hue,
      dash: linkPen.dash,
      points: [100, -40, 130, -40],
      width: linkPen.weight,
    });
  });

  it("routes a scenario: the current faint, the proposed with its progress, a ring on a responsibility and an arrowhead on a file", () => {
    const overlay: ResponsibilityOverlay = {
      ...bare,
      routes: {
        baseline: [
          {
            source: { id: "one", kind: "file" },
            target: { id: "two", kind: "file" },
          },
        ],
        progress: 0.4,
        proposed: [
          {
            source: { id: "one", kind: "file" },
            target: { id: "scope", kind: "responsibility" },
          },
        ],
        scopes: [{ files: ["two", "three"], id: "scope" }],
      },
    };
    const marks = responsibilityMarks({
      overlay,
      pixels: 5,
      territory: island,
    });
    const [current, arrow, proposed] = strokes(marks);
    const baseline = inkStyle("scenario-baseline");
    expect(current).toMatchObject({
      alpha: inkAlpha.scenarioBaseline,
      colour: baseline.hue,
      dash: baseline.dash,
      points: [100, -40, 130, -40],
      width: baseline.weight,
    });
    // Five pixels of arrowhead at five a unit: one unit back from the target.
    expect(arrow?.points).toHaveLength(6);
    expect(arrow?.points.slice(2, 4)).toEqual([130, -40]);
    expect(arrow?.points[0]).toBeCloseTo(130 - Math.cos(0.5));
    const proposal = inkStyle("scenario-proposed");
    expect(proposed).toMatchObject({
      alpha: 0.4,
      colour: proposal.hue,
      points: [100, -40, 115, -25],
    });
    const [ring] = glyphs(marks);
    expect(ring).toMatchObject({
      alpha: 0.4,
      colour: proposal.hue,
      shape: "hoop",
      size: 12,
      weight: proposal.weight,
      x: 115,
      y: -25,
    });
  });

  it("draws the composition in map units about its file, clipped to the coast, revealed with the zoom", () => {
    const overlay: ResponsibilityOverlay = {
      ...bare,
      composition: {
        active: ["lit"],
        fileId: "one",
        marks: [
          { group: "g", id: "lit", x: 2, y: 0 },
          { group: "g", id: "plain", x: 0, y: 2 },
          { group: "g", id: "far", x: 60, y: 0 },
        ],
        names: {},
        stationary: ["lit", "plain", "far"],
      },
      trace: {
        blockers: ["plain"],
        marks: [{ group: "g", id: "lit", x: 8, y: 0 }],
        progress: 0.5,
        stationary: [],
      },
    };
    const marks = responsibilityMarks({
      overlay,
      pixels: 8,
      territory: island,
    });
    const paper = fills(marks);
    // Two declarations on land and one ghost veil; the far mark is past the coast.
    expect(paper).toHaveLength(3);
    expect(paper[0]?.polygon[0]).toEqual([
      [101.2, -40.8],
      [102.8, -40.8],
      [102.8, -39.2],
      [101.2, -39.2],
      [101.2, -40.8],
    ]);
    expect(paper.every((mark) => mark.colour === inks.paper)).toBe(true);
    expect(alphaAt(paper[0]?.alpha ?? 0, 6)).toBe(0);
    expect(alphaAt(paper[0]?.alpha ?? 0, 8)).toBe(1);
    // The veil under a ghost, drawn next, is fainter by the paper veil's share.
    expect(alphaAt(paper[1]?.alpha ?? 0, 8)).toBeCloseTo(inkAlpha.paperVeil);
    const outlines = strokes(marks).filter((mark) => mark.width === 1);
    const [lit, tether, ghost, plain, blocker] = outlines;
    expect(lit?.colour).toBe(inks.evidence);
    expect(lit?.points).toEqual([
      101.5, -40.5, 102.5, -40.5, 102.5, -39.5, 101.5, -39.5, 101.5, -40.5,
    ]);
    // The trace moves the lit declaration halfway toward its target, on a dashed tether.
    const proposal = inkStyle("inspection-proposal");
    expect(tether).toMatchObject({
      colour: inks.evidence,
      dash: proposal.dash,
      points: [102, -40, 105, -40],
    });
    expect(ghost).toMatchObject({ colour: inks.evidence, dash: proposal.dash });
    expect(plain?.colour).toBe(inks.declarationBlocker);
    expect(blocker?.points).toEqual([99.5, -38.5, 100.5, -37.5]);
    expect(outlines.some((mark) => (mark.points[0] ?? 0) > 150)).toBe(false);
  });

  it("keeps the squares of the marks at rest by identity across the zoom, and lets a moved file replace them", () => {
    const overlay: ResponsibilityOverlay = {
      ...bare,
      composition: {
        active: [],
        fileId: "one",
        marks: [
          { group: "g", id: "still", x: 2, y: 0 },
          { group: "g", id: "moving", x: 0, y: 2 },
        ],
        names: {},
        stationary: ["still"],
      },
    };
    const build = (pixels: number, territory: Territory) =>
      responsibilityMarks({ overlay, pixels, territory });
    // At seven pixels a unit the reveal is still spreading: the stationary mark is at rest, the other is not.
    const spreading = build(7, island);
    const again = build(7.5, island);
    expect(fills(spreading)[0]?.polygon).toBe(fills(again)[0]?.polygon);
    expect(fills(spreading)[1]?.polygon).not.toBe(fills(again)[1]?.polygon);
    const outlines = (marks: readonly Mark[]) =>
      strokes(marks).map((mark) => mark.points);
    expect(outlines(spreading)[0]).toBe(outlines(again)[0]);
    // Revealed, every mark is at rest, and a rebuild for the zoom hands the renderer the same geometry.
    const revealed = build(8, island);
    const closer = build(9, island);
    expect(fills(revealed).map((mark) => mark.polygon)).toEqual(
      fills(closer).map((mark) => mark.polygon)
    );
    for (const [index, fill] of fills(revealed).entries()) {
      expect(fill.polygon).toBe(fills(closer)[index]?.polygon);
    }
    expect(outlines(revealed)[1]).toBe(outlines(closer)[1]);
    // A relayout that moves the file hands back squares at the new centre.
    const moved: Territory = {
      ...island,
      files: [file("one", 5, 5), file("two", 30, 0), file("three", 0, 30)],
    };
    const [paper] = fills(build(9, moved));
    expect(paper?.polygon).not.toBe(fills(closer)[0]?.polygon);
    expect(paper?.polygon[0]?.[0]).toEqual([106.2, -35.8]);
  });

  it("follows the zoom only while something is laid in world units at it", () => {
    expect(responsibilityFollowsZoom(bare)).toBe(false);
    expect(responsibilityFollowsZoom({ ...bare, members: ["one"] })).toBe(
      false
    );
    expect(responsibilityFollowsZoom({ ...bare, hints: ["one"] })).toBe(true);
    expect(responsibilityFollowsZoom({ ...bare, unresolved: ["one"] })).toBe(
      true
    );
    expect(
      responsibilityFollowsZoom({
        ...bare,
        routes: { baseline: [], progress: 0, proposed: [], scopes: [] },
      })
    ).toBe(true);
    expect(
      responsibilityFollowsZoom({
        ...bare,
        composition: { active: [], fileId: "one", marks: [], names: {} },
      })
    ).toBe(false);
  });

  it("builds a crowded composition within a frame's budget", () => {
    const coast = Array.from({ length: 240 }, (_, i): [number, number] => [
      48 * Math.cos((i / 240) * Math.PI * 2),
      48 * Math.sin((i / 240) * Math.PI * 2),
    ]);
    const round: Territory = { ...island, coast: [[coast]] };
    const marks = Array.from({ length: 150 }, (_, i) => ({
      group: "g",
      id: `s${i}`,
      x: (i % 15) * 1.8 - 12.6,
      y: Math.floor(i / 15) * 1.8 - 9,
    }));
    const overlay: ResponsibilityOverlay = {
      ...bare,
      composition: { active: [], fileId: "one", marks, names: {} },
      members: ["one"],
    };
    const start = performance.now();
    const built = responsibilityMarks({ overlay, pixels: 8, territory: round });
    const elapsed = performance.now() - start;
    expect(fills(built)).toHaveLength(150);
    expect(elapsed).toBeLessThan(50);
  });
});
