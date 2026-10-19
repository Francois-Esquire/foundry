import { describe, expect, it } from "vitest";
import { chartGrid } from "../../src/web/data/bindings";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import { coastMarks } from "../../src/web/layout/coast-marks";
import { chartGridMarks } from "../../src/web/layout/grid-marks";
import { hoverMarks } from "../../src/web/layout/hover-marks";
import {
  alphaAt,
  glyphOn,
  inkedStroke,
  internAlpha,
  type Stroke,
} from "../../src/web/layout/marks";
import {
  coastPenRuns,
  coastPolylines,
  penWeights,
} from "../../src/web/layout/pen-runs";
import { markLayers } from "../../src/web/scene/marks/layers";
import {
  keyedMarks,
  type MarkFrame,
  staticMarks,
} from "../../src/web/scene/marks/mark-layer";
import {
  createViewState,
  resolveShown,
  type ViewState,
} from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";

const circle = Array.from({ length: 41 }, (_, index): [number, number] => [
  40 * Math.cos((index / 40) * Math.PI * 2),
  40 * Math.sin((index / 40) * Math.PI * 2),
]);

const shore: Territory = {
  analyzed: true,
  coast: [[circle]],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: -50,
};

describe("chart grid marks", () => {
  it("rules the whole sea at fixed steps, minor lines fading with zoom", () => {
    const sea = { height: 360, width: 900 };
    const marks = chartGridMarks(sea);
    const { majorStep, minorStep } = chartGrid(1);
    const minor = marks.filter((mark) => mark.width === 0.5);
    const major = marks.filter((mark) => mark.width === 0.7);
    expect(minor).toHaveLength(
      Math.floor(900 / minorStep) + 1 + Math.floor(360 / minorStep) + 1
    );
    expect(major).toHaveLength(
      Math.floor(900 / majorStep) + 1 + Math.floor(360 / majorStep) + 1
    );
    expect(new Set(marks.map((mark) => mark.colour))).toEqual(
      new Set([inks.grid])
    );
    expect(marks.every((mark) => mark.on === undefined)).toBe(true);
    const vertical = major.find((mark) => mark.points[0] === 0);
    expect(vertical?.points).toEqual([0, -180, 0, 180]);
    expect(alphaAt(major[0]?.alpha ?? 0, 1)).toBe(inkAlpha.gridMajor);
    expect(alphaAt(minor[0]?.alpha ?? 0, 1)).toBe(0);
    expect(alphaAt(minor[0]?.alpha ?? 0, 4)).toBeCloseTo(0.14);
    // One shared alpha per step: the renderer keeps one batch each.
    expect(new Set(minor.map((mark) => mark.alpha)).size).toBe(1);
  });
});

describe("coast marks", () => {
  const strokesOf = (marks: readonly Stroke[], colour: string) =>
    marks.filter((mark) => mark.colour === colour);

  it("drapes a gilt rule, its frame and the pen on the island, in the chart's coordinates", () => {
    const marks = coastMarks([shore], null);
    expect(marks.every((mark) => mark.on === shore)).toBe(true);
    const [frame] = strokesOf(marks, inks.coastFrame);
    const [rule] = strokesOf(marks, inks.coastRule);
    expect(frame?.points.slice(0, 2)).toEqual([140, -50]);
    expect(rule?.points).toEqual(frame?.points);
    expect(frame?.width).toBeGreaterThan(rule?.width ?? 0);
    expect(frame?.alpha).toBe(inkAlpha.coastFrame);
    expect(rule?.alpha).toBe(1);
    // The frame draws first, so the rule sits over it.
    expect(marks.indexOf(frame as Stroke)).toBeLessThan(
      marks.indexOf(rule as Stroke)
    );
    const pen = strokesOf(marks, inks.coastPen);
    expect(pen.length).toBeGreaterThan(1);
    expect(new Set(pen.map((mark) => mark.width)).size).toBeGreaterThan(2);
    expect(pen.every((mark) => mark.alpha === inkAlpha.coastPen)).toBe(true);
    expect(pen.every((mark) => mark.cap === "round")).toBe(true);
  });

  it("inks the same pen pressure on every build, and presses harder when selected", () => {
    const widths = (selectedId: string | null) =>
      strokesOf(coastMarks([shore], selectedId), inks.coastPen).map(
        (mark) => mark.width
      );
    expect(widths(null)).toEqual(widths(null));
    expect(coastPenRuns(shore)).toBe(coastPenRuns(shore));
    const plain = widths(null);
    const selected = widths("island");
    expect(selected).toHaveLength(plain.length);
    for (const [index, width] of selected.entries()) {
      expect(width).toBeCloseTo((plain[index] ?? 0) * 1.3);
    }
    for (const width of plain) {
      expect(penWeights).toContain(width);
    }
  });
});

describe("keyed marks", () => {
  it("keeps the same array while every key is the same value, and rebuilds on any change", () => {
    let built = 0;
    let reveal: number | undefined = 0.5;
    const marks = keyedMarks(
      () => [reveal, "fixed"],
      () => {
        built += 1;
        return [];
      }
    );
    const frame = {} as MarkFrame;
    const first = marks(frame);
    expect(marks(frame)).toBe(first);
    expect(built).toBe(1);
    reveal = 0.75;
    expect(marks(frame)).not.toBe(first);
    reveal = undefined;
    marks(frame);
    expect(built).toBe(3);
  });
});

describe("mark layers", () => {
  const file = {
    directory: "src",
    highFanIn: false,
    id: "one",
    incoming: 0,
    internalFanIn: 0,
    kind: "source",
    outgoing: 0,
    path: "src/one.ts",
    x: 0,
    y: 0,
  };
  const island = { ...shore, files: [file] };
  const data = {
    coverage: "test",
    fileEdges: [],
    folderCells: {},
    frames: [],
    height: 400,
    packageLayers: {},
    routes: [],
    territories: [island],
    width: 400,
  };
  const layer = (id: string) => {
    const found = markLayers.find((item) => item.id === id);
    if (!found) {
      throw new Error(`no layer ${id}`);
    }
    return found;
  };
  /** The chart's fixed geometry: one object, as the scene holds one. */
  const chart: MarkFrame["chart"] = {
    boundaries: {
      clearance: [],
      coasts: [],
      footprint: [],
      groups: [],
      outer: [],
      pockets: [],
    },
    ripples: [],
    sea: { height: 400, width: 400 },
    topography: [],
  };
  /** A frame over the state, resolved against the view first, as the scene resolves it before any layer runs. */
  const frameAt = (
    state: ViewState,
    view: Partial<MarkFrame["view"]> = {}
  ): MarkFrame => {
    const inkView = {
      height: 100,
      pixelsPerUnit: 8,
      width: 100,
      x: 100,
      y: -50,
      ...view,
    };
    state.shown = resolveShown(state, inkView);
    return { chart, state, time: 0, view: inkView };
  };
  /** Every layer's marks for the frame, by id. */
  const allMarks = (frame: MarkFrame) =>
    new Map(markLayers.map((item) => [item.id, item.marks(frame)]));
  /** A district of the island, by id, holding the given files. */
  const region = (id: string, members: (typeof file)[] = []) => ({
    color: "#688c77",
    id,
    label: id,
    members,
    polygons: [],
    uncertain: false,
  });
  const overlay = {
    links: [],
    members: ["one"],
    pathDisagreement: [],
    related: [],
    territoryId: "island",
    totalLinks: 0,
    unresolved: [],
  };

  it("holds the whole z-order, bottom to top, ending in the ink canvas's eight layers in its order", () => {
    expect(markLayers.map((item) => item.id)).toEqual([
      "chart-grid",
      "sea-ripples",
      "coast",
      "belonging",
      "folders",
      "domain",
      "connections",
      "files",
      "file-members",
      "responsibility",
      "proximity",
      "file-focus",
      "topography",
      "crossings",
      "departures",
      "domain-departures",
      "selection",
      "boundaries",
      "hover",
    ]);
  });

  it("inks the hovered island from the state, and nothing once the hover is gone", () => {
    const state = createViewState(data, defaultChartSettings);
    const { marks } = layer("hover");
    expect(marks(frameAt(state))).toEqual([]);
    const [territory = null] = data.territories;
    state.hovered = territory;
    const hovered = marks(frameAt(state));
    expect(hovered.length).toBe(2);
    expect(marks(frameAt(state))).toBe(hovered);
    state.hovered = null;
    expect(marks(frameAt(state))).toEqual([]);
  });

  it("draws the contours only while they are on, and rebuilds them when a composition veils them", () => {
    const state = createViewState(data, defaultChartSettings);
    const { marks } = layer("topography");
    const contoured = {
      ...chart,
      topography: [
        {
          elevation: 0,
          major: true,
          opacity: 1,
          points: [
            [0, 0],
            [1, 0],
          ] as [number, number][],
          sea: true,
        },
      ],
    };
    expect(marks({ ...frameAt(state), chart: contoured })).toEqual([]);
    state.settings = { ...state.settings, contours: true };
    const drawn = marks({ ...frameAt(state), chart: contoured });
    expect(drawn).toHaveLength(1);
    expect(marks({ ...frameAt(state, { x: 300 }), chart: contoured })).toBe(
      drawn
    );
  });

  it("keeps the responsibility layer still while its composition's file is out of view, and rebuilds it with the zoom while a drawing shows", () => {
    const state = createViewState(data, defaultChartSettings);
    state.selected = "island";
    state.responsibility = {
      composition: {
        active: [],
        fileId: "one",
        marks: [{ group: "g", id: "s", x: 2, y: 0 }],
        names: {},
      },
      links: [],
      members: ["one"],
      pathDisagreement: [],
      related: [],
      territoryId: "island",
      totalLinks: 0,
      unresolved: [],
    };
    const { marks } = layer("responsibility");
    // The file at (100, −50) is out of a view 500 units east.
    const away = frameAt(state, { x: 600 });
    const first = marks(away);
    expect(first.length).toBeGreaterThan(0);
    expect(marks(frameAt(state, { pixelsPerUnit: 9, x: 600 }))).toBe(first);
    // In view, the drawing is laid at the zoom, so the zoom rebuilds it.
    const shown = marks(frameAt(state));
    expect(shown).not.toBe(first);
    expect(shown.length).toBeGreaterThan(first.length);
    expect(marks(frameAt(state))).toBe(shown);
    expect(marks(frameAt(state, { pixelsPerUnit: 9 }))).not.toBe(shown);
  });

  it("builds the files layer once per islands and evidence, never for a zoom", () => {
    const state = createViewState(data, defaultChartSettings);
    const { marks } = layer("files");
    const first = marks(frameAt(state));
    expect(first.length).toBe(2);
    expect(marks(frameAt(state, { pixelsPerUnit: 2 }))).toBe(first);
    state.responsibility = overlay;
    expect(marks(frameAt(state))).not.toBe(first);
  });

  it("rebuilds the belonging layer alone for a frame of the reveal, and for a frame of the hover's emphasis", () => {
    const state = createViewState(data, defaultChartSettings);
    const district = region("district", [file]);
    state.selected = "island";
    state.selectedFile = "one";
    state.responsibility = overlay;
    state.belonging = {
      pinned: district.id,
      regions: [district],
      territory: island,
    };
    state.belongingReveal = 0.2;
    const revealing = allMarks(frameAt(state));
    state.belongingReveal = 0.6;
    const revealed = allMarks(frameAt(state));
    expect(revealed.get("belonging")).not.toBe(revealing.get("belonging"));
    for (const [id, marks] of revealed) {
      if (id !== "belonging") {
        expect(marks, id).toBe(revealing.get(id));
      }
    }
    expect(revealed.get("file-members")?.length).toBe(2);
    state.belongingReveal = undefined;
    state.belongingHover = { emphasis: 0.3, hovered: district.id };
    const rising = allMarks(frameAt(state));
    state.belongingHover = { emphasis: 0.7, hovered: district.id };
    const risen = allMarks(frameAt(state));
    expect(risen.get("belonging")).not.toBe(rising.get("belonging"));
    for (const [id, marks] of risen) {
      if (id !== "belonging") {
        expect(marks, id).toBe(rising.get(id));
      }
    }
  });

  it("rebuilds the members and not the files for a hover from one group to the next", () => {
    const state = createViewState(data, defaultChartSettings);
    const first = region("first", [file]);
    const second = region("second");
    state.selected = "island";
    state.belonging = { regions: [first, second], territory: island };
    state.belongingHover = { emphasis: 1, hovered: first.id };
    const over = allMarks(frameAt(state));
    expect(over.get("file-members")?.length).toBe(2);
    state.belongingHover = { emphasis: 1, hovered: second.id };
    const moved = allMarks(frameAt(state));
    expect(moved.get("file-members")).not.toBe(over.get("file-members"));
    expect(moved.get("file-members")).toEqual([]);
    expect(moved.get("files")).toBe(over.get("files"));
  });

  it("resolves the same view for a frame that moved nothing, and its overlay through a reveal", () => {
    const state = createViewState(data, defaultChartSettings);
    state.selected = "island";
    state.responsibility = overlay;
    state.belonging = { regions: [], territory: island };
    // The pointer left the chart and its emphasis lingers: the common pan.
    state.belongingHover = { emphasis: 1 };
    const { shown } = frameAt(state).state;
    expect(frameAt(state, { x: 101 }).state.shown).toBe(shown);
    state.belongingReveal = 0.5;
    const { shown: revealing } = frameAt(state).state;
    expect(revealing).not.toBe(shown);
    expect(revealing.responsibility).toBe(shown.responsibility);
    expect(revealing.evidenceFiles).toBe(shown.evidenceFiles);
  });
});

describe("static marks", () => {
  it("keeps the same array while its inputs are the same objects", () => {
    let built = 0;
    const marks = staticMarks(
      ({ state }) => [state.drawingData.territories, state.selected] as const,
      (_islands: readonly Territory[], _selected: string | null) => {
        built += 1;
        return [];
      }
    );
    const frameWith = (some: Territory[], selectedId: string | null) =>
      ({
        state: { drawingData: { territories: some }, selected: selectedId },
      }) as unknown as MarkFrame;
    const islands = [shore];
    const first = marks(frameWith(islands, null));
    expect(marks(frameWith(islands, null))).toBe(first);
    expect(built).toBe(1);
    expect(marks(frameWith(islands, "island"))).not.toBe(first);
    expect(marks(frameWith([shore], "island"))).not.toBe(first);
    expect(built).toBe(3);
  });
});

describe("the producers' scaffolding", () => {
  it("inks a stroke from a ladder row, opaque and flat unless told, passing the cap through as given", () => {
    const crossing = inkStyle("crossing");
    const points = [0, 0, 10, 0];
    expect(inkedStroke(crossing, points)).toEqual({
      alpha: 1,
      cap: undefined,
      colour: crossing.hue,
      dash: [10, 4],
      kind: "stroke",
      on: undefined,
      points,
      width: crossing.weight,
    });
    // A site's own cap, plane, alpha, ink and width win over the row's; a solid row has no dash.
    const pressed = inkedStroke(inkStyle("coast"), points, {
      alpha: 0.5,
      cap: "round",
      colour: inks.hover,
      on: shore,
      width: 3,
    });
    expect(pressed).toMatchObject({
      alpha: 0.5,
      cap: "round",
      colour: inks.hover,
      dash: undefined,
      on: shore,
      width: 3,
    });
    expect(pressed.points).toBe(points);
  });

  it("drapes a glyph at an island-local point, moved onto the chart", () => {
    expect(
      glyphOn(
        shore,
        { x: 3, y: -4 },
        { alpha: 1, colour: inks.selection, shape: "dot", size: 4 }
      )
    ).toEqual({
      alpha: 1,
      colour: inks.selection,
      kind: "glyph",
      on: shore,
      shape: "dot",
      size: 4,
      x: 103,
      y: -54,
    });
  });

  it("shares one alpha function per key, making each once", () => {
    const share = internAlpha();
    let made = 0;
    const make = () => {
      made += 1;
      return (pixels: number) => pixels / 2;
    };
    const faint = share("faint", make);
    expect(share("faint", make)).toBe(faint);
    expect(share("strong", make)).not.toBe(faint);
    expect(made).toBe(2);
    expect(alphaAt(faint, 4)).toBe(2);
    const byNumber = internAlpha<number>();
    expect(byNumber(0.5, make)).toBe(byNumber(0.5, make));
  });

  it("drapes the hover and the coast on the same polylines of one island", () => {
    const rings = coastPolylines(shore);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.slice(0, 2)).toEqual([140, -50]);
    expect(coastPolylines(shore)).toBe(rings);
    const coast = coastMarks([shore], null).filter(
      (mark) => mark.colour === inks.coastRule
    );
    const hover = hoverMarks(shore);
    expect(coast[0]?.points).toBe(rings[0]);
    expect(hover[0]?.points).toBe(rings[0]);
    expect(hover[1]?.points).toBe(rings[0]);
  });
});
