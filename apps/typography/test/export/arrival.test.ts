import { describe, expect, it } from "vitest";
import { arrivalOf } from "~/export/arrival";
import {
  exportFaceHash,
  exportInstancesHash,
  readExportPath,
} from "~/export/export-address";
import { startDraft } from "~/export/plan-draft";
import { pinInstance } from "~/typeface/project";
import { describeFace } from "../helpers/fixtures";
import { importFace, startProject } from "../packaging/helpers/projects";

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};
const LATIN = { code: "Latn", kind: "script" } as const;

const started = startProject("Static.ttf", describeFace());
const flex = importFace(
  started.project,
  "Flex.ttf",
  describeFace({ axes: [WEIGHT], familyName: "Flex" })
);
const light = pinInstance(flex.project, flex.faceId, { wght: 300 }, "Light");
const bold = pinInstance(light.project, flex.faceId, { wght: 700 }, "Bold");
const { project } = bold;

/** A plan somebody has already worked on, to see what an arrival keeps. */
const worked = {
  ...startDraft(flex.faceId),
  blocks: ["Basic Latin"],
  familyName: "Atlas Sans",
  format: "woff2",
  keep: "selection",
} as const;

describe("the Export place's addresses", () => {
  it("writes a face, a subset of it and the instances of a variable face, and reads each back", () => {
    expect(exportFaceHash("ab12:0")).toBe("#/export/face/ab12%3A0");
    expect(exportFaceHash("ab12:0", LATIN)).toBe("#/export/face/ab12%3A0/Latn");
    expect(exportInstancesHash("ab12:0")).toBe("#/export/instances/ab12%3A0");
    expect(readExportPath(["face", "ab12:0"])).toEqual({
      faceId: "ab12:0",
      kind: "face",
      scope: undefined,
      unknownScope: undefined,
    });
    expect(readExportPath(["face", "ab12:0", "shared.digits"])).toMatchObject({
      scope: { group: "digits", kind: "shared" },
    });
    expect(readExportPath(["instances", "ab12:0"])).toEqual({
      faceId: "ab12:0",
      kind: "instances",
    });
  });

  it("asks for nothing when bare, and keeps a writing system Unicode does not have to say so", () => {
    expect(readExportPath([])).toBeUndefined();
    expect(readExportPath(["face"])).toBeUndefined();
    expect(readExportPath(["glyph", "a"])).toBeUndefined();
    expect(readExportPath(["face", "ab12:0", "Klingon"])).toMatchObject({
      scope: undefined,
      unknownScope: "Klingon",
    });
  });
});

describe("arriving in Export from another place", () => {
  it("plans the face whole, keeping the name and format chosen here", () => {
    const arrival = arrivalOf(
      { faceId: started.faceId, kind: "face" },
      project,
      worked
    );
    expect(arrival).toEqual({
      draft: { ...worked, faceIds: [started.faceId], keep: "everything" },
      kind: "planned",
    });
  });

  it("does not let a subset from an earlier arrival cut down a face asked for whole", () => {
    const subset = arrivalOf(
      { faceId: started.faceId, kind: "face", scope: LATIN },
      project,
      startDraft(started.faceId)
    );
    const earlier = subset.kind === "planned" ? subset.draft : worked;
    expect(earlier.keep).toBe("selection");
    const whole = arrivalOf(
      { faceId: started.faceId, kind: "face" },
      project,
      earlier
    );
    expect(whole.kind === "planned" && whole.draft.keep).toBe("everything");
    const instances = arrivalOf(
      { faceId: flex.faceId, kind: "instances" },
      project,
      earlier
    );
    expect(instances.kind === "planned" && instances.draft.keep).toBe(
      "everything"
    );
  });

  it("plans a subset for one writing system, replacing any other selection", () => {
    const arrival = arrivalOf(
      { faceId: started.faceId, kind: "face", scope: LATIN },
      project,
      worked
    );
    expect(arrival.kind === "planned" && arrival.draft).toMatchObject({
      blocks: [],
      faceIds: [started.faceId],
      familyName: "Atlas Sans",
      format: "woff2",
      keep: "selection",
      scripts: ["Latn"],
      sharedGroups: [],
    });
  });

  it("chooses every pinned instance of a variable face, and not the variable face", () => {
    const arrival = arrivalOf(
      { faceId: flex.faceId, kind: "instances" },
      project,
      startDraft(started.faceId)
    );
    expect(arrival.kind === "planned" && arrival.draft.faceIds).toEqual([
      light.face.id,
      bold.face.id,
    ]);
  });

  it("leaves the plan alone and says why when the address names something that is not there", () => {
    const missed = (address: Parameters<typeof arrivalOf>[0]) => {
      const arrival = arrivalOf(address, project, worked);
      return arrival.kind === "missed" ? arrival.reason : "";
    };
    expect(missed({ faceId: "gone", kind: "face" })).toContain(
      "not in the project"
    );
    expect(missed({ faceId: started.faceId, kind: "instances" })).toContain(
      "has no pinned instance yet"
    );
    expect(
      missed({ faceId: started.faceId, kind: "face", unknownScope: "Klingon" })
    ).toContain("No writing system is called Klingon");
  });
});
