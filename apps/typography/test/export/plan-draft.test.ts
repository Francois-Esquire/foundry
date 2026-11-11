import { describe, expect, it } from "vitest";
import { planOf, resolveDraft, startDraft, toggled } from "~/export/plan-draft";
import { readRanges } from "~/export/typed-ranges";
import { characterLookups } from "~/export/unicode-lookups";
import { resolveExportPlan } from "~/packaging/resolving";
import { describeFace } from "../helpers/fixtures";
import { startProject } from "../packaging/helpers/projects";

const { faceId, project } = startProject("Specimen.ttf", describeFace());

describe("reading typed characters", () => {
  it("reads code points and ranges in the usual spellings", () => {
    expect(readRanges("U+0041, u+20ac 0915; U+0100-U+017F 0x30..0x39")).toEqual(
      {
        selectors: [
          { codePoints: [0x41], kind: "characters" },
          { codePoints: [0x20_ac], kind: "characters" },
          { codePoints: [0x09_15], kind: "characters" },
          { first: 0x01_00, kind: "range", last: 0x01_7f },
          { first: 0x30, kind: "range", last: 0x39 },
        ],
        unreadable: [],
      }
    );
  });

  it("puts a range the right way round and names what it cannot read", () => {
    expect(readRanges("U+005A-U+0041, latin, U+110000")).toEqual({
      selectors: [{ first: 0x41, kind: "range", last: 0x5a }],
      unreadable: ["latin", "U+110000"],
    });
    expect(readRanges("  ")).toEqual({ selectors: [], unreadable: [] });
  });
});

describe("turning a draft into an export plan", () => {
  it("starts as one whole face under its own name", () => {
    expect(planOf(startDraft(faceId), project)).toEqual({
      plan: {
        characters: { kind: "everything" },
        faces: [{ faceId, variable: undefined }],
        familyName: undefined,
        features: { kind: "needed" },
        format: "ttf",
      },
      problems: [],
    });
    expect(planOf(startDraft(undefined), project).plan.faces).toEqual([]);
  });

  it("adds up every way of naming characters", () => {
    const { plan } = planOf(
      {
        ...startDraft(faceId),
        blocks: ["Basic Latin"],
        keep: "selection",
        languages: ["hi"],
        ranges: "U+0100-U+017F",
        scripts: ["Deva"],
        sharedGroups: ["digits"],
        typed: "ab",
      },
      project
    );
    if (plan.characters.kind !== "selected") {
      throw new Error("The plan keeps everything.");
    }
    const [script, shared, ...others] = plan.characters.selectors;
    expect(script).toEqual({ kind: "script", script: "Deva" });
    // A shared group is no script, so it is spelled out character by character.
    expect(shared?.kind === "characters" && shared.codePoints).toContain(0x30);
    expect(others).toEqual([
      { block: "Basic Latin", kind: "block" },
      { kind: "language", language: "hi" },
      { codePoints: [0x61, 0x62], kind: "characters" },
      { first: 0x01_00, kind: "range", last: 0x01_7f },
    ]);
  });

  it("carries the treatment, the trimmed name, the format and the chosen features", () => {
    const { plan } = planOf(
      {
        ...startDraft(faceId),
        familyName: "  Atlas Sans ",
        features: "chosen",
        featureTags: ["liga"],
        format: "woff2",
        treatments: { [faceId]: { kind: "keep-variable" } },
      },
      project
    );
    expect(plan).toMatchObject({
      faces: [{ faceId, variable: { kind: "keep-variable" } }],
      familyName: "Atlas Sans",
      features: { kind: "chosen", tags: ["liga"] },
      format: "woff2",
    });
  });

  it("leaves out a face that is no longer in the project", () => {
    const draft = { ...startDraft(faceId), faceIds: ["gone", faceId] };
    expect(planOf(draft, project).plan.faces).toEqual([
      { faceId, variable: undefined },
    ]);
  });

  it("reports what was typed and cannot be read, only while a selection is being made", () => {
    const draft = { ...startDraft(faceId), ranges: "latin, U+0041" };
    expect(planOf(draft, project).problems).toEqual([]);
    expect(planOf({ ...draft, keep: "selection" }, project).problems).toEqual([
      '"latin" is not a code point or a range. Write code points as U+0041 and ranges as U+0041-U+005A, with commas between them.',
    ]);
  });

  it("resolves a draft the way packaging resolves its plan, with what was typed wrongly beside it", () => {
    const lookups = characterLookups([], () => [0x41]);
    const draft = {
      ...startDraft(faceId),
      keep: "selection" as const,
      ranges: "latin, U+0041",
    };
    const { plan, problems } = planOf(draft, project);
    expect(resolveDraft(project, draft, lookups)).toEqual({
      resolution: resolveExportPlan(project, plan, lookups),
      typingProblems: problems,
    });
    expect(problems).toHaveLength(1);
  });

  it("switches a value on and off without repeating it", () => {
    expect(toggled(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a", false)).toEqual(["b"]);
  });
});
