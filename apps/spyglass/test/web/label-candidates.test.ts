import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { labelUnder } from "../../src/web/interaction/hit";
import { inks } from "../../src/web/ladder/ink-ladder";
import type { BelongingLayer } from "../../src/web/layout/belonging";
import { memberContours } from "../../src/web/layout/belonging";
import { belongingView } from "../../src/web/layout/belonging-view";
import {
  type DomainRef,
  domainExtent,
} from "../../src/web/layout/domain-extent";
import { settleFiles } from "../../src/web/layout/folder-sectors";
import {
  labelCandidates,
  labelEvidence,
  placeLabels,
} from "../../src/web/layout/label-candidates";
import {
  labelWorldPoint,
  liftedY,
  type MapLabel,
  type TextMeasure,
} from "../../src/web/layout/labels";
import type { ResponsibilityOverlay } from "../../src/web/layout/responsibility-focus";
import {
  drapedHeight,
  flatMarkHeight,
} from "../../src/web/layout/terrain-height";
import { chartTilt, type InkView } from "../../src/web/view/chart-view";
import { detailLevel } from "../../src/web/view/detail-level";
import { withReadings } from "../helpers/frames";
import {
  twoIslands as data,
  ownRelief,
  island as territory,
} from "../helpers/island-fixture";
import { twins } from "../helpers/twins";

/** A fake measure: every character is 0.55 em wide, whatever the font. */
const measure: TextMeasure = (text) => text.length * 0.55;

/** What the painter's options were: the labels proposed and placed for a frame, as the labels layer does it. */
function labelsFor(options: {
  belonging?: BelongingLayer | null;
  data: SpyglassData;
  domain?: DomainRef | null;
  fileId?: string | null;
  fileHeight?: (
    fileId: string,
    view: InkView,
    data: SpyglassData
  ) => number | undefined;
  responsibility?: ResponsibilityOverlay | null;
  selected?: string | null;
  view: InkView;
}): MapLabel[] {
  const fileId = options.fileId ?? null;
  const selected = options.selected ?? null;
  const resolved = belongingView({
    belonging: options.belonging ?? null,
    fileId,
    matches: undefined,
    responsibility: options.responsibility ?? null,
    selected,
    territories: options.data.territories,
    view: options.view,
  });
  const candidates = labelCandidates(
    {
      belonging: resolved.belonging,
      composition: resolved.responsibility?.composition,
      data: options.data,
      detail: detailLevel(options.view.pixelsPerUnit, resolved.hasComposition),
      domain: options.domain
        ? domainExtent(options.data, options.domain)
        : null,
      evidenceFiles: labelEvidence(resolved),
      fileHeight: options.fileHeight,
      fileId,
      reliefOf: ownRelief,
      selected,
      view: options.view,
    },
    measure
  );
  return placeLabels(candidates, options.view, fileId);
}

const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };

it("anchors a selected file name above its current roof and falls back when architecture is hidden", () => {
  const close = { ...view, pixelsPerUnit: 5, presentation: 1, tilt: 0.9 };
  const options = { data, fileId: "one", selected: "island", view: close };
  const normal = labelsFor(options).find(
    (label) => label.place?.file?.id === "one"
  );
  const raised = labelsFor({
    ...options,
    fileHeight: (id) => (id === "one" ? 18 : undefined),
  }).find((label) => label.place?.file?.id === "one");
  assert(normal && raised);
  expect(raised.z).toBe(18);
  expect(labelWorldPoint(raised, close.tilt).x).toBe(
    labelWorldPoint(normal, close.tilt).x
  );
  expect(labelWorldPoint(raised, close.tilt).y).toBeCloseTo(
    labelWorldPoint(normal, close.tilt).y
  );
  expect(
    labelUnder([raised], raised.x, raised.y - raised.height / 2, close)
  ).toBe(raised);
  expect(labelsFor({ ...options, fileHeight: () => undefined })).toEqual(
    labelsFor(options)
  );
});

it("retains parent labels through composition and leaves neighboring anchors passive", () => {
  const parent = {
    anchor: territory.files[1],
    children: ["child"],
    color: "#678",
    id: "composite",
    label: "Parent",
    members: territory.files,
    polygons: memberContours(territory.files),
    uncertain: false,
  };
  const neighbor = { ...parent, id: "neighbor", label: "Neighbor" };
  const labels = labelsFor({
    belonging: {
      files: territory.files.slice(0, 1),
      parents: [parent],
      regions: [],
      surroundings: [neighbor],
      territory,
    },
    data,
    fileId: "one",
    responsibility: {
      composition: {
        active: [],
        fileId: "one",
        marks: [{ group: "group", id: "symbol", x: 2, y: 0 }],
        names: { symbol: "Symbol" },
      },
      links: [],
      members: ["one"],
      pathDisagreement: [],
      related: [],
      territoryId: "island",
      totalLinks: 0,
      unresolved: [],
    },
    selected: "island",
    view: { ...view, pixelsPerUnit: 8 },
  });
  expect(labels.some((label) => label.place?.compositeId === "composite")).toBe(
    true
  );
  expect(labels.some((label) => label.place?.compositeId === "neighbor")).toBe(
    false
  );
  expect(labels.some((label) => label.place?.file?.id === "one")).toBe(true);
});

it("replaces old district labels with exact group identity", () => {
  const region = {
    color: "#687",
    id: "belonging",
    label: "Responsibility",
    members: territory.files.slice(0, 1),
    polygons: memberContours(territory.files.slice(0, 1)),
    uncertain: false,
  };
  const labels = labelsFor({
    belonging: { pinned: region.id, regions: [region], territory },
    data,
    selected: "island",
    view,
  });
  expect(labels.some((label) => label.place?.regionId === region.id)).toBe(
    true
  );
  const close = labelsFor({
    belonging: { pinned: region.id, regions: [region], territory },
    data,
    selected: "island",
    view: { ...view, pixelsPerUnit: 5 },
  });
  expect(close.some((label) => label.place?.file?.id === "two")).toBe(false);
});

it("retires district and neighboring file labels as composition becomes dominant", () => {
  // A selected island shows no grouping until its responsibilities load.
  const unentered = labelsFor({ data, selected: "island", view });
  expect(
    unentered
      .filter((label) => label.territory?.id === "island")
      .map((label) => label.text)
  ).toEqual(["Island"]);
  const district = {
    color: "#678",
    id: "district",
    label: "District",
    members: territory.files,
    polygons: memberContours(territory.files),
    uncertain: false,
  };
  const districts = labelsFor({
    belonging: { regions: [district], territory },
    data,
    selected: "island",
    view,
  });
  expect(districts.some((label) => label.place?.regionId === "district")).toBe(
    true
  );
  expect(districts.some((label) => label.kind === "file")).toBe(false);
  const files = labelsFor({
    data,
    selected: "island",
    view: { ...view, pixelsPerUnit: 5 },
  });
  expect(files.filter((label) => label.kind === "file")).toHaveLength(2);
  const focused = labelsFor({
    data,
    fileId: "one",
    selected: "island",
    view: { ...view, pixelsPerUnit: 5 },
  });
  expect(
    focused
      .filter((label) => label.kind === "file")
      .map((label) => label.place?.file?.id)
  ).toEqual(["one"]);
  const overlay: ResponsibilityOverlay = {
    composition: {
      active: [],
      fileId: "one",
      marks: [{ group: "group", id: "symbol", x: 2, y: 0 }],
      names: { symbol: "Symbol" },
    },
    links: [],
    members: ["one"],
    pathDisagreement: [],
    related: [],
    territoryId: "island",
    totalLinks: 0,
    unresolved: [],
  };
  const composition = labelsFor({
    data,
    fileId: "one",
    responsibility: overlay,
    selected: "island",
    view: { ...view, pixelsPerUnit: 8 },
  });
  expect(
    composition
      .filter((label) => label.kind === "file")
      .map((label) => label.place?.file?.id)
  ).toEqual(["one"]);
  // The file's name is boxed where it is seen: north of the file by its mark's lift.
  const [one] = territory.files;
  assert(one);
  expect(
    composition.find((label) => label.place?.file?.id === "one")?.y
  ).toBeCloseTo(liftedY(-21 / 8, drapedHeight(territory, one.x, one.y)));
  const elsewhere = labelsFor({
    data,
    fileId: "one",
    responsibility: overlay,
    selected: "island",
    view: { ...view, pixelsPerUnit: 8, width: 40, x: 30 },
  });
  expect(
    elsewhere
      .filter((label) => label.kind === "file")
      .map((label) => label.place?.file?.id)
  ).toEqual(["two"]);
});

it("limits relationship labels to evidence and keeps a bounded amount of ink", () => {
  const [source] = territory.files;
  assert(source);
  const populated = {
    ...territory,
    files: Array.from({ length: 80 }, (_, index) => ({
      ...source,
      id: `file:${index}`,
      path: `src/file-${index}.ts`,
      x: (index % 10) * 15 - 70,
      y: Math.floor(index / 10) * 15 - 55,
    })),
  };
  const crowdedView = { height: 140, pixelsPerUnit: 5, width: 180, x: 0, y: 0 };
  const crowded = labelsFor({
    data: { ...data, territories: [populated] },
    selected: "island",
    view: crowdedView,
  });
  expect(
    crowded.filter((label) => label.kind === "file").length
  ).toBeLessThanOrEqual(15);
  const focused = labelsFor({
    data: { ...data, territories: [populated] },
    responsibility: {
      links: [],
      members: ["file:0"],
      pathDisagreement: [],
      related: [],
      territoryId: "island",
      totalLinks: 0,
      unresolved: [],
    },
    selected: "island",
    view: crowdedView,
  });
  expect(
    focused
      .filter((label) => label.kind === "file")
      .map((label) => label.place?.file?.id)
  ).toEqual(["file:0"]);
});

it("captions each package name with its real file count, and marks an unplaced island", () => {
  const labels = labelsFor({
    data: { ...data, packageLayers: { island: 0, other: null } },
    view: { ...view, pixelsPerUnit: 1 },
  });
  const caption = (text: string) =>
    labels
      .filter((label) => label.kind === "island")
      .find((label) => label.text === text)?.caption;
  expect(caption("Island")).toBe("2 FILES");
  expect(caption("Other")).toBe("0 FILES · NO LAYER");
});

it("sets each label in the ladder's inks and halos, measured in its font", () => {
  const close = { ...view, pixelsPerUnit: 5 };
  const labels = labelsFor({
    data,
    fileId: "one",
    selected: "island",
    view: close,
  });
  const selected = labels.find((label) => label.place?.file?.id === "one");
  const name = labels.find((label) => label.kind === "island");
  // Other files are named while no file is focused in view.
  const file = labelsFor({ data, selected: "island", view: close }).find(
    (label) => label.place?.file?.id === "two"
  );
  assert(selected && name && file);
  expect(selected).toMatchObject({
    font: { face: "SpyglassBody" },
    halo: 6,
    height: 20 / 5,
    ink: inks.selection,
    kind: "file",
  });
  expect(selected.width).toBeCloseTo("one.ts".length * 0.55 * (20 / 5));
  expect(name).toMatchObject({
    font: { face: "SpyglassDisplay" },
    halo: 6,
    ink: inks.label,
  });
  expect(file).toMatchObject({ halo: 3, ink: inks.label, kind: "file" });
  // The gilt and amber the ladder replaced are gone from the labels.
  for (const label of labels) {
    expect(["#b38a32", "#875222"]).not.toContain(label.ink);
  }
});

const folderedFiles = [
  "pkg/src/web/a.ts",
  "pkg/src/web/b.ts",
  "pkg/src/lib/c.ts",
  "pkg/src/lib/d.ts",
].map((path, i) => ({
  ...territory.files[0],
  directory: path.slice(0, path.lastIndexOf("/")),
  id: path,
  path,
  x: i,
  y: 0,
})) as Territory["files"];
const folderedIsland = { ...territory, files: folderedFiles, folder: "pkg" };
const folderTree = settleFiles(folderedFiles, 80, "pkg");
const foldered = {
  ...data,
  folderCells: { island: folderTree },
  territories: [folderedIsland],
};

it("names folders at island zoom in italics ending in a slash, and none on an island rearranged by responsibility", () => {
  const islandView = { ...view, pixelsPerUnit: 2.2 };
  const shown = labelsFor({ data: foldered, view: islandView });
  expect(shown).toContainEqual(
    expect.objectContaining({
      font: { face: "SpyglassBody", italic: true, letterSpacing: 0 },
      ink: inks.folder,
      kind: "folder",
      text: "lib/",
    })
  );
  const rearranged = labelsFor({
    belonging: {
      regions: [],
      territory: {
        ...folderedIsland,
        files: folderedFiles.map((f) => ({ ...f })),
      },
    },
    data: foldered,
    view: islandView,
  });
  expect(rearranged.map((label) => label.text)).not.toContain("lib/");
});

it("leaves a district's name to the folder when the district is named as the folder it sits in, and sets folder names above their bead", () => {
  const region = (
    id: string,
    label: string,
    members: typeof folderedFiles
  ) => ({
    color: "#000000",
    id,
    label,
    members,
    polygons: [],
    uncertain: false,
  });
  const lib = folderedFiles.filter((f) => f.directory.endsWith("lib"));
  const web = folderedFiles.filter((f) => f.directory.endsWith("web"));
  const labels = labelsFor({
    belonging: {
      regions: [region("r1", "src/lib", lib), region("r2", "Sessions", web)],
      territory: folderedIsland,
    },
    data: foldered,
    view: { ...view, pixelsPerUnit: 2.2 },
  });
  const texts = labels.map((label) => label.text);
  expect(texts).toContain("lib/");
  expect(texts).not.toContain("lib");
  // A district named otherwise keeps its name beside the folder's.
  expect(texts).toContain("Sessions");
  const libCell = folderTree.folders[0]?.folders.find(
    (cell) => cell.folder === "src/lib"
  );
  const centroid =
    (libCell?.sites ?? []).reduce((sum, site) => sum + site.y, 0) /
    Math.max(1, libCell?.sites.length ?? 1);
  expect(labels.find((label) => label.text === "lib/")?.y).toBeCloseTo(
    centroid - 13 / 2.2
  );
});

it("letters a chosen domain's name once, in the domain's ink, which a click passes through; nothing unchosen", () => {
  const other = { ...territory, files: [], folder: "other", id: "other" };
  const chosen = withReadings(
    { ...foldered, territories: [folderedIsland, other] },
    {
      domains: {
        declared: [
          {
            name: "shapes",
            parents: [],
            places: [
              { kind: "folder" as const, place: "pkg/src/lib" },
              { kind: "file" as const, place: "pkg/src/web/a.ts" },
            ],
            unmatched: [],
          },
        ],
        placements: {},
      },
    }
  );
  const islandView = { ...view, pixelsPerUnit: 2.2 };
  const shown = labelsFor({
    data: chosen,
    domain: { frame: "", name: "shapes" },
    view: islandView,
  });
  const names = shown.filter((label) => label.text === "domain shapes");
  expect(names).toHaveLength(1);
  const [name] = names;
  assert(name);
  expect(name).toMatchObject({ halo: 6, ink: inks.domainName, kind: "domain" });
  expect(labelUnder([name], name.x, name.y - name.height / 2)).toBeUndefined();
  const unchosen = labelsFor({ data: chosen, view: islandView });
  expect(unchosen.map((label) => label.text)).not.toContain("domain shapes");
});

it.each([undefined, 0, (55 * Math.PI) / 180])(
  "boxes a raised name at its projected position for tilt %s",
  (tilt) => {
    const shore: Territory = {
      ...territory,
      coast: [
        [
          [
            [-90, -90],
            [90, -90],
            [90, 90],
            [-90, 90],
          ],
        ],
      ],
      files: territory.files.map((member) => ({
        ...member,
        highFanIn: true,
        internalFanIn: 20,
      })),
      highFanInCutoff: 3,
    };
    const labels = labelsFor({
      data: { ...data, territories: [shore] },
      selected: "island",
      view: { ...view, pixelsPerUnit: 5, tilt },
    });
    const file = labels.find((label) => label.place?.file?.id === "one");
    const name = labels.find((label) => label.kind === "island");
    assert(file?.place?.file && name);
    // The file's name takes the height its mark is draped at.
    const raised = drapedHeight(shore, file.place.file.x, file.place.file.y);
    expect(file.z).toBeCloseTo(raised);
    expect(file.z).toBeGreaterThan(flatMarkHeight);
    const ground = file.place.file.y - 7 / 5;
    expect(file.y).toBeCloseTo(
      ground - (raised - flatMarkHeight) * Math.tan(tilt ?? chartTilt)
    );
    expect(labelWorldPoint(file, tilt)).toEqual({
      x: file.x,
      y: expect.closeTo(ground),
      z: raised,
    });
    // The island's name sits on the sea, off the coast, and is not lifted.
    expect(name.z).toBe(flatMarkHeight);
    expect(labelWorldPoint(name, tilt).y).toBe(name.y);
  }
);

/** The whole chart at one pixel per unit. */
const whole = (spyglass: SpyglassData) => ({
  height: spyglass.height,
  pixelsPerUnit: 1,
  width: spyglass.width,
  x: 0,
  y: 0,
});

/** A caption with nothing after its file count. */
const endsWithCount = /FILES?$/;

it("sets each frame's label above it, in spaced capitals measured with their spacing, which a click passes through, and adds a frame's label to the captions of names two frames share", async () => {
  const { spyglass, single } = await twins();
  const labels = labelsFor({ data: spyglass, view: whole(spyglass) });
  const frames = labels.filter((label) => label.kind === "frame");
  expect(frames.map((label) => label.text)).toEqual(["FIRST", "SECOND"]);
  // Each names its frame, and no island.
  expect(frames.map((label) => label.frame.id)).toEqual(
    spyglass.frames.map((frame) => frame.id)
  );
  expect(frames.every((label) => label.territory === undefined)).toBe(true);
  for (const label of frames) {
    expect(label).toMatchObject({
      font: { face: "SpyglassBody", letterSpacing: 3 / 14 },
      kind: "frame",
    });
    expect(label.width).toBeCloseTo(label.text.length * 0.55 * 14);
    expect(labelUnder(labels, label.x, label.y - label.height / 2)).toBe(
      undefined
    );
  }
  const names = labels.filter((label) => label.kind === "island");
  expect(names.length).toBeGreaterThan(0);
  for (const label of names) {
    const frame = spyglass.frames.find((each) =>
      each.territories.includes(label.territory?.id ?? "")
    );
    expect(label.caption).toMatch(
      new RegExp(` · ${frame?.label.toUpperCase()}$`)
    );
  }
  // A name only one frame has keeps its caption as a single workspace's.
  const [, second] = spyglass.frames;
  const renamed = spyglass.territories.find((island) =>
    second?.territories.includes(island.id)
  );
  assert(renamed);
  const twin = spyglass.territories.find(
    (island) => island.label === renamed.label && island.id !== renamed.id
  );
  const apart: SpyglassData = {
    ...spyglass,
    territories: spyglass.territories.map((island) =>
      island.id === renamed.id ? { ...island, label: "Only here" } : island
    ),
  };
  const captions = new Map(
    labelsFor({ data: apart, view: whole(apart) })
      .filter((label) => label.kind === "island")
      .map((label) => [label.territory?.id, label.caption])
  );
  assert(twin);
  for (const id of [renamed.id, twin.id]) {
    expect(captions.get(id)).toMatch(endsWithCount);
  }
  // A single workspace has no frame label, and no caption names one.
  const alone = labelsFor({ data: single, view: whole(single) });
  expect(alone.some((label) => label.kind === "frame")).toBe(false);
  expect(
    alone.some(
      (label) => label.kind === "island" && label.caption.includes(" · ")
    )
  ).toBe(false);
});

it("centres frame labels over their islands without reserving a canvas compass", async () => {
  const { spyglass } = await twins();
  const [, frame] = spyglass.frames;
  assert(frame);
  const islands = spyglass.territories.filter((island) =>
    frame.territories.includes(island.id)
  );
  expect(islands.length).toBeGreaterThan(0);
  const label = labelsFor({ data: spyglass, view: whole(spyglass) }).find(
    (item) => item.kind === "frame" && item.frame.id === frame.id
  );
  assert(label);
  const west = Math.min(...islands.map((island) => island.x - island.radius));
  const east = Math.max(...islands.map((island) => island.x + island.radius));
  expect(label.x).toBeCloseTo((west + east) / 2);
});
