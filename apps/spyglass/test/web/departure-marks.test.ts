import { expect, it } from "vitest";
import type {
  SpyglassData,
  SpyglassFile,
  Territory,
} from "../../src/web/data/types";
import type { CodexPlacement } from "../../src/web/data/vocabulary";
import { departureRing, inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import {
  departureMarks,
  domainDepartureMarks,
} from "../../src/web/layout/departure-marks";
import { departures } from "../../src/web/layout/departures";
import { nearestCoast } from "../../src/web/layout/dependency-links";
import type { DomainExtent } from "../../src/web/layout/domain-extent";
import type { Glyph } from "../../src/web/layout/marks";
import { singleFrame } from "../helpers/frames";

const square: Territory["coast"] = [
  [
    [
      [-20, -20],
      [20, -20],
      [20, 20],
      [-20, 20],
      [-20, -20],
    ],
  ],
];

const file = (path: string, x: number): SpyglassFile => ({
  directory: path.slice(0, path.lastIndexOf("/")),
  highFanIn: false,
  id: path,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path,
  x,
  y: 0,
});

const island = (
  id: string,
  folder: string,
  x: number,
  paths: string[]
): Territory => ({
  analyzed: true,
  coast: square,
  fileRoles: undefined,
  files: paths.map((path, i) => file(path, i * 10)),
  folder,
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 20,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y: 0,
});

const place = (
  path: string,
  level: CodexPlacement["level"],
  pkg: string,
  toward: string
): CodexPlacement => ({
  away: [{ modules: 2, package: toward }],
  home: 0,
  label: "departs",
  level,
  package: pkg,
  place: path,
  share: 1,
  toward,
  unindexed: 0,
});

const placements = [
  place("packages/a/src/x.ts", "file", "@s/a", "@s/t"),
  place("packages/a/lib", "folder", "@s/a", "@s/t"),
];

const data = {
  frames: [
    singleFrame(["@s/a", "@s/t"], {
      placement: {
        dominantShare: 0.6,
        labelled: ["@s/a"],
        places: Object.fromEntries(
          placements.map((p) => [`${p.level}:${p.place}`, p])
        ),
      },
    }),
  ],
  territories: [
    island("@s/a", "packages/a", 0, [
      "packages/a/lib/z.ts",
      "packages/a/src/x.ts",
    ]),
    island("@s/t", "packages/t", 300, ["packages/t/src/t.ts"]),
  ],
} as unknown as SpyglassData;

it("rings each departure upright on its island at the ladder's radius and weight", () => {
  const marks = departureMarks(data, null);
  const rings = marks.filter(
    (mark) => mark.kind === "glyph" && mark.shape === "notchedRing"
  );
  expect(rings).toHaveLength(2);
  const ring = inkStyle("departure");
  const [folder, departing] = departures(data).marks;
  expect(rings[0]).toMatchObject({
    colour: ring.hue,
    on: data.territories[0],
    size: 2 * departureRing.radius.folder,
    upright: true,
    weight: ring.weight,
    x: folder?.x,
    y: folder?.y,
  });
  expect(rings[1]).toMatchObject({
    size: 2 * departureRing.radius.file,
    x: departing?.x,
  });
});

it("draws a dash-dot line to the nearest coast of the target with a bead there, flat on the sea, and none while anything is selected", () => {
  const marks = departureMarks(data, null);
  const lines = marks.filter((mark) => mark.kind === "stroke");
  const beads = marks.filter(
    (mark): mark is Glyph => mark.kind === "glyph" && mark.shape === "dot"
  );
  expect(lines).toHaveLength(2);
  expect(beads).toHaveLength(2);
  const pen = inkStyle("departure-line");
  const [line] = lines;
  expect(line?.dash).toEqual(pen.dash);
  expect(line?.dash).toHaveLength(4);
  expect(line?.colour).toBe(inks.departureLine);
  expect(line?.on).toBeUndefined();
  // The line ends seven units short of the target's nearest coast point.
  const [folder] = departures(data).lines;
  const [, target] = data.territories;
  const [coastX, coastY] =
    folder && target
      ? nearestCoast([folder.from.x, folder.from.y], target)
      : [0, 0];
  const [endX = 0, endY = 0] = line?.points.slice(-2) ?? [];
  expect(Math.hypot(coastX - endX, coastY - endY)).toBeCloseTo(7);
  expect([beads[0]?.x, beads[0]?.y]).toEqual([endX, endY]);
  expect(beads[0]?.colour).toBe(inkStyle("departure-bead").hue);
  const selected = departureMarks(data, "@s/t");
  expect(selected.every((mark) => mark.kind === "glyph")).toBe(true);
  expect(selected).toHaveLength(2);
  // The same spyglass hands the renderer the same curves.
  expect(
    departureMarks(data, null).find((mark) => mark.kind === "stroke")?.points
  ).toBe(line?.points);
});

it("plugs the notch of each ring the chosen domain explains, in the domain's ink and the ring's size", () => {
  const [folder] = departures(data).marks;
  const domain = {
    explained: new Set(["folder:packages/a/lib"]),
    frame: folder?.frame,
  } as unknown as DomainExtent;
  const plugs = domainDepartureMarks(data, domain);
  expect(plugs).toHaveLength(1);
  const pen = inkStyle("domain-explained");
  expect(plugs[0]).toMatchObject({
    colour: inks.domain,
    on: data.territories[0],
    shape: "notchPlug",
    size: 2 * departureRing.radius.folder,
    upright: true,
    weight: pen.weight,
    x: folder?.x,
    y: folder?.y,
  });
  expect(domainDepartureMarks(data, null)).toEqual([]);
  expect(
    domainDepartureMarks(data, { ...domain, explained: new Set() })
  ).toEqual([]);
});
