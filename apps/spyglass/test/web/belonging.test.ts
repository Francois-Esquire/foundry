import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import {
  belongingAncestry,
  compositeRegions,
  fileDistricts,
  hitBelonging,
  memberContours,
} from "../../src/web/layout/belonging";
import { compositionInsideLand } from "../../src/web/layout/composition-placement";

const file = (id: string, x: number, y = 0): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: id,
  x,
  y,
});

describe("composite map binding", () => {
  const region = (id: string, members: SpyglassFile[], uncertain = false) => ({
    color: "#678",
    id,
    label: id,
    members,
    polygons: memberContours(members),
    uncertain,
  });
  const responsibilityGroups = {
    groups: [
      {
        anchor: "a",
        anchorModule: "a2",
        anchorWeight: 4,
        id: "west",
        label: "a",
        modules: ["a", "a2", "b"],
        responsibilities: ["a", "b"],
      },
      {
        anchor: "c",
        anchorWeight: 4,
        id: "east",
        label: "c",
        modules: ["c", "d"],
        responsibilities: ["c", "d"],
      },
    ],
    independent: ["alone"],
  };
  const regions = [
    region("a", [file("a", -24), file("a2", -22)]),
    region("b", [file("b", -20)]),
    region("c", [file("c", 20)]),
    region("d", [file("d", 24)]),
    region("alone", [file("alone", 0)]),
    region("unresolved:u", [file("u", 4)], true),
  ];

  it("draws broader districts without claiming independent or unresolved evidence", () => {
    const before = structuredClone(regions);
    const composites = compositeRegions(responsibilityGroups, regions);
    expect(composites.map((group) => group.id)).toEqual([
      "west",
      "east",
      "collection:independent",
      "collection:unresolved",
    ]);
    expect(composites[0]?.members.map((member) => member.id)).toEqual([
      "a",
      "a2",
      "b",
    ]);
    // The anchor is the file at the lens's anchor module, here the anchor
    // responsibility's second file by id; a group without one has no mark.
    expect(composites[0]?.anchor?.id).toBe("a2");
    expect(composites[1]?.anchor).toBeUndefined();
    expect(hitBelonging({ regions: composites, territory }, -12, 0)?.id).toBe(
      "west"
    );
    expect(hitBelonging({ regions: composites, territory }, 12, 0)?.id).toBe(
      "east"
    );
    expect(
      hitBelonging({ regions: composites, territory }, 0, 0)
    ).toBeUndefined();
    expect(
      composites
        .filter((group) => group.collection)
        .every((group) => !group.polygons.length)
    ).toBe(true);
    expect(regions).toEqual(before);
  });

  it("reconstructs direct file ancestry and retains a valid entered shared parent", () => {
    const shared = file("shared", 0);
    const children = [region("a", [shared]), region("b", [shared])];
    const parents = [
      { ...region("one", [shared]), children: ["a"] },
      { ...region("two", [shared]), children: ["b"] },
    ];
    expect(belongingAncestry(children, parents, { fileId: "shared" })).toEqual({
      compositeId: "one",
      regionId: "a",
    });
    expect(
      belongingAncestry(children, parents, {
        compositeId: "two",
        fileId: "shared",
      })
    ).toEqual({ compositeId: "two", regionId: "b" });
    expect(belongingAncestry(children, parents, { regionId: "b" })).toEqual({
      compositeId: "two",
      regionId: "b",
    });
  });

  it("keeps hover on an eligible overlap and ignores hidden children", () => {
    const children = [
      region("a", [file("a", -2)]),
      region("b", [file("b", 2)]),
    ];
    expect(
      hitBelonging({ hovered: "a", regions: children, territory }, 1, 0)?.id
    ).toBe("a");
    expect(
      hitBelonging(
        { hovered: "b", regions: children.slice(0, 1), territory },
        1,
        0
      )?.id
    ).toBe("a");
    expect(hitBelonging({ regions: [], territory }, 1, 0)).toBeUndefined();
  });

  it("limits outlying child hits to exact marks rather than invisible footprints", () => {
    const child = region("child", [file("outlier", 25)]);
    const parent = {
      ...region("parent", [file("center", 0)]),
      children: ["child"],
    };
    const layer = { parents: [parent], regions: [child], territory };
    expect(hitBelonging(layer, 25, 0, 2)?.id).toBe("child");
    expect(hitBelonging(layer, 29, 0, 2)).toBeUndefined();
  });
});
const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-40, -40],
        [40, -40],
        [40, 40],
        [-40, 40],
        [-40, -40],
      ],
      [
        [4, 4],
        [8, 4],
        [8, 8],
        [4, 8],
        [4, 4],
      ],
    ],
  ],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 50,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};

describe("belonging footprints", () => {
  it("keeps isolated members and disconnected patches", () => {
    const files = [file("one", -25), file("two", -22), file("distant", 25)];
    const contours = memberContours(files);
    expect(contours).toHaveLength(2);
    for (const member of files) {
      expect(compositionInsideLand(member.x, member.y, contours)).toBe(true);
    }
    expect(compositionInsideLand(0, 0, contours)).toBe(false);
  });
  it("is independent of ordering, duplication, and incoming connection weights", () => {
    const files = [file("one", 0), file("two", 4)];
    expect(memberContours(files)).toEqual(memberContours([...files].reverse()));
    expect(memberContours(files)).toEqual(
      memberContours([...files, { ...file("one", 0), incoming: 1000 }])
    );
  });
  it("rejects water and holes and does not infer enclosed membership", () => {
    const members = [file("one", 3, 6), file("two", 38)];
    const region = {
      color: "#678",
      id: "group",
      label: "Group",
      members,
      polygons: memberContours(members),
      uncertain: false,
    };
    const layer = { regions: [region], territory };
    expect(hitBelonging(layer, 6, 6)).toBeUndefined();
    expect(hitBelonging(layer, 41, 0)).toBeUndefined();
    expect(hitBelonging(layer, 2, 6)?.id).toBe("group");
    expect(region.members.map((member) => member.id)).toEqual(["one", "two"]);
  });
  it("resolves overlapping patches by nearest actual member, with stable ties", () => {
    const region = (id: string, x: number) => ({
      color: "#678",
      id,
      label: id,
      members: [file(id, x)],
      polygons: memberContours([file(id, x)]),
      uncertain: false,
    });
    const regions = [region("a", -2), region("b", 2)];
    expect(hitBelonging({ regions, territory }, 1, 0)?.id).toBe("b");
    expect(
      hitBelonging({ regions: [...regions].reverse(), territory }, 0, 0)?.id
    ).toBe("a");
  });
  it("does not mutate files or geography", () => {
    const files = [Object.freeze(file("one", 0))];
    const coast = JSON.stringify(territory.coast);
    memberContours(files);
    expect(files[0]?.x).toBe(0);
    expect(JSON.stringify(territory.coast)).toBe(coast);
    expect(memberContours([])).toEqual([]);
  });
});

it("gives each file its district, its responsibility's group, and none for an independent responsibility or unresolved belonging", () => {
  const a = file("a", 0);
  const b = file("b", 0);
  const c = file("c", 0);
  const d = file("d", 0);
  const region = (id: string, members: SpyglassFile[], uncertain = false) => ({
    color: "#000",
    id,
    label: id,
    members,
    polygons: [],
    uncertain,
  });
  const grouped = region("responsibility:grouped", [a, b]);
  const alone = region("responsibility:alone", [c, a]);
  const unresolved = region("unresolved:d", [d], true);
  const group = {
    ...region("responsibility-group:g", [a, b]),
    children: [grouped.id],
  };
  const districts = fileDistricts(
    [alone, grouped, unresolved].sort((x, y) => x.id.localeCompare(y.id)),
    [group]
  );
  // a is also in "alone", which joined no group: the group decides.
  expect(districts.get("a")?.id).toBe(group.id);
  expect(districts.get("b")?.id).toBe(group.id);
  expect(districts.has("c")).toBe(false);
  expect(districts.has("d")).toBe(false);
});
