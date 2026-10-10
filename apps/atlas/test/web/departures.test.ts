import { expect, it } from "vitest";
import type { CodexPlacement } from "../../src/web/codex/vocabulary";
import {
  departures,
  leastConsumers,
  linesPerTarget,
} from "../../src/web/departures";
import type { AtlasData, AtlasFile, Territory } from "../../src/web/types";

const file = (path: string, x: number): AtlasFile => ({
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

const island = (id: string, folder: string, paths: string[]): Territory => ({
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: paths.map((path, i) => file(path, i * 10)),
  folder,
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x: 1000,
  y: 0,
});

/** A place of `pkg`, departing toward `toward` with `share` unless it is spread. */
const place = (
  path: string,
  level: CodexPlacement["level"],
  pkg: string,
  share: number,
  toward?: string,
  consumers = 1
): CodexPlacement => ({
  away: toward ? [{ modules: consumers, package: toward }] : [],
  home: 0,
  label: toward ? "departs" : "spread",
  level,
  package: pkg,
  place: path,
  share,
  ...(toward ? { toward } : {}),
  unindexed: 0,
});

const placements = [
  place("packages/a/src/x.ts", "file", "@s/a", 1, "@s/t", 2),
  place("packages/a/src/y.ts", "file", "@s/a", 0.7, "@s/t", 2),
  // a/lib rests on one consumer module in t: too thin to draw a line.
  place("packages/a/lib/z.ts", "file", "@s/a", 0.6, "@s/t"),
  place("packages/a/lib", "folder", "@s/a", 0.65, "@s/t"),
  place("packages/a/src/x.ts#x", "symbol", "@s/a", 1, "@s/t"),
  place("packages/a/src/w.ts", "file", "@s/a", 0.4),
  // b's only consumer is t: one mark for the package, none for its file.
  place("packages/b", "package", "@s/b", 1, "@s/t", 3),
  place("packages/b/src/p.ts", "file", "@s/b", 1, "@s/t", 3),
  place("packages/c/f1/a.ts", "file", "@s/c", 0.9, "@s/t", 2),
  place("packages/c/f2/a.ts", "file", "@s/c", 0.9, "@s/t", 4),
  place("packages/c/f3/a.ts", "file", "@s/c", 0.6, "@s/u"),
];

const data = {
  placement: {
    labelled: ["@s/a", "@s/b", "@s/c"],
    places: Object.fromEntries(
      placements.map((p) => [`${p.level}:${p.place}`, p])
    ),
  },
  territories: [
    island("@s/a", "packages/a", [
      "packages/a/lib/z.ts",
      "packages/a/src/w.ts",
      "packages/a/src/x.ts",
      "packages/a/src/y.ts",
    ]),
    island("@s/b", "packages/b", [
      "packages/b/src/p.ts",
      "packages/b/src/q.ts",
    ]),
    island("@s/c", "packages/c", [
      "packages/c/f1/a.ts",
      "packages/c/f2/a.ts",
      "packages/c/f3/a.ts",
    ]),
  ],
} as unknown as AtlasData;

it("marks each departing file and folder where it lies, and a single-consumer package once", () => {
  const { marks } = departures(data);
  expect(marks.map((mark) => `${mark.level} ${mark.place}`)).toEqual([
    "folder packages/a/lib",
    "file packages/a/lib/z.ts",
    "file packages/a/src/x.ts",
    "file packages/a/src/y.ts",
    "package packages/b",
    "file packages/c/f1/a.ts",
    "file packages/c/f2/a.ts",
    "file packages/c/f3/a.ts",
  ]);
  const x = marks.find((mark) => mark.place === "packages/a/src/x.ts");
  // The island sits at x 1000; x.ts is its third file, 20 units in.
  expect(x).toMatchObject({ toward: "@s/t", x: 1020, y: 0 });
  // b's mark is the centroid of its files.
  expect(marks.find((mark) => mark.level === "package")).toMatchObject({
    x: 1005,
  });
});

it("ranks lines by dominance share, then evidence, then breadth, draws only those on two consumer modules, at most three into a package", () => {
  const { lines, totals } = departures(data);
  expect(lines.map((line) => `${line.folder} → ${line.toward}`)).toEqual([
    // b and a/src tie at a share of 1: b rests on more consumer modules.
    "packages/b → @s/t",
    "packages/a/src → @s/t",
    // f1 and f2 tie at 0.9: f2 rests on four consumer modules, f1 on two.
    "packages/c/f2 → @s/t",
  ]);
  expect(lines.filter((line) => line.toward === "@s/t")).toHaveLength(
    linesPerTarget
  );
  expect(lines[1]?.places).toEqual([
    "packages/a/src/x.ts",
    "packages/a/src/y.ts",
  ]);
  expect(lines.every((line) => line.consumers >= leastConsumers)).toBe(true);
  expect(totals).toEqual({
    candidateLines: 6,
    departing: 9,
    folded: 1,
    symbols: 1,
    thinLines: 2,
  });
});

it("draws nothing for an atlas whose places all stay home", () => {
  expect(
    departures({
      ...data,
      placement: { labelled: [], places: {} },
    } as AtlasData)
  ).toEqual({
    lines: [],
    marks: [],
    totals: {
      candidateLines: 0,
      departing: 0,
      folded: 0,
      symbols: 0,
      thinLines: 0,
    },
  });
});
