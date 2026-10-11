import { expect, it } from "vitest";
import type { ProximityCoChange } from "../../src/lib/lenses/proximity-types";
import {
  drawnTies,
  proximities,
  tieCount,
  tiesByKind,
} from "../../src/web/proximity";
import type { AtlasData, AtlasFile, Territory } from "../../src/web/types";

const file = (path: string, x: number, y = 0): AtlasFile => ({
  directory: path.slice(0, path.lastIndexOf("/")),
  highFanIn: false,
  id: path,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path,
  x,
  y,
});

const island = (id: string, x: number, files: AtlasFile[]): Territory => ({
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files,
  folder: `packages/${id}`,
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y: 0,
});

const pair = (
  left: string,
  right: string,
  coChangeCommits: number,
  scope: ProximityCoChange["scope"] = "same-package"
): ProximityCoChange => ({
  coChangeCommits,
  distance: 2,
  id: `${left}|${right}`,
  jaccard: 0.5,
  left,
  right,
  scope,
  staticPath: "none",
});

const a = island("a", 100, [
  file("packages/a/lib/x.ts", -10),
  file("packages/a/lib/y.ts", -6),
  file("packages/a/src/p.ts", 10),
  file("packages/a/src/q.ts", 14),
  file("packages/a/src/deep/r.ts", 20),
  ...Array.from({ length: 8 }, (_, i) => file(`packages/a/t/f${i}.ts`, i)),
]);
const b = island("b", 500, [file("packages/b/src/z.ts", 0)]);

const data = {
  proximity: {
    apart: {
      coChanges: [
        pair("packages/a/lib/x.ts", "packages/a/src/p.ts", 3),
        pair("packages/a/lib/y.ts", "packages/a/src/q.ts", 6),
        // Across packages: told in Place, never drawn over the sea.
        pair("packages/a/lib/x.ts", "packages/b/src/z.ts", 9, "cross-package"),
        ...Array.from({ length: 6 }, (_, i) =>
          pair(`packages/a/t/f${i}.ts`, "packages/a/src/q.ts", 1)
        ),
      ],
      files: [
        {
          distance: 2,
          file: "packages/a/src/p.ts",
          folder: "packages/a/src",
          package: "a",
          responsibility: "responsibility:r",
          responsibilityFolder: "packages/a/lib",
        },
      ],
    },
    close: [
      {
        folder: "packages/a/src",
        groups: [
          {
            apart: [],
            files: ["packages/a/src/p.ts"],
            responsibilities: ["r1"],
          },
          {
            apart: [],
            files: ["packages/a/src/q.ts"],
            responsibilities: ["r2"],
          },
        ],
        package: "a",
        unresolved: 0,
      },
    ],
    labelled: ["a", "b"],
  },
  territories: [a, b],
} as unknown as AtlasData;

it("ranks an island's ties co-changes first, by commits, then the files apart, and leaves co-changes across packages to Place", () => {
  const ties = proximities(data).ties.get("a") ?? [];
  expect(ties.map((tie) => `${tie.kind} ${tie.files.join(" ")}`)).toEqual([
    "co-change packages/a/lib/y.ts packages/a/src/q.ts",
    "co-change packages/a/lib/x.ts packages/a/src/p.ts",
    ...Array.from(
      { length: 6 },
      (_, i) => `co-change packages/a/t/f${i}.ts packages/a/src/q.ts`
    ),
    "apart packages/a/src/p.ts",
  ]);
  expect(proximities(data).ties.get("b")).toBeUndefined();
  // An apart file is tied to its responsibility's folder: lib's two files' centroid.
  expect(ties.at(-1)?.to).toEqual({ x: 92, y: 0 });
});

it("draws 3 co-change ties and 2 apart ties on an island, one kind making up for the other, or every tie of a selected file", () => {
  const drawn = drawnTies(data, "a");
  // Eight co-changes and one apart file: the apart kind's spare share goes
  // to a fourth co-change.
  expect(drawn.map((tie) => tie.kind)).toEqual([
    "co-change",
    "co-change",
    "co-change",
    "co-change",
    "apart",
  ]);
  expect(drawn).toHaveLength(tiesByKind.apart + tiesByKind["co-change"]);
  expect(tieCount(data, "a")).toEqual({ all: 9, drawn: 5 });
  const own = drawnTies(data, "a", "packages/a/src/p.ts");
  expect(own.map((tie) => tie.kind)).toEqual(["co-change", "apart"]);
  // A selected file with no ties leaves the island's own.
  expect(drawnTies(data, "a", "packages/a/src/deep/r.ts")).toEqual(drawn);
});

it("gives a kind short of co-changes' share to the apart ties", () => {
  const apartOnly = {
    ...data,
    proximity: {
      ...data.proximity,
      apart: {
        coChanges: [],
        files: ["x", "y", "p", "q"].map((name) => ({
          distance: 1,
          file: `packages/a/${name === "x" || name === "y" ? "lib" : "src"}/${name}.ts`,
          folder: "",
          package: "a",
          responsibility: "r",
          responsibilityFolder: "packages/a/t",
        })),
      },
    },
  } as AtlasData;
  expect(drawnTies(apartOnly, "a").map((tie) => tie.kind)).toEqual([
    "apart",
    "apart",
    "apart",
    "apart",
  ]);
});

it("marks a close folder at the centroid of the files directly in it", () => {
  expect(proximities(data).marks).toEqual([
    { folder: "packages/a/src", groups: 2, package: "a", x: 112, y: 0 },
  ]);
});
