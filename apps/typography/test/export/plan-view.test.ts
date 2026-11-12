import { describe, expect, it } from "vitest";
import { sameDraft, startDraft } from "~/export/plan-draft";
import { planView } from "~/export/plan-view";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("the export plan view", () => {
  it("keeps an unavailable chosen script visible and reports malformed typed ranges", async () => {
    const workspace = testWorkspace();
    try {
      const { faceId } = await importOne(workspace, fixtureFile("lato"));
      const draft = {
        ...startDraft(faceId),
        keep: "selection" as const,
        ranges: "invalid",
        scripts: ["Deva"],
      };
      const view = planView(
        workspace.getState().project,
        draft,
        workspace.openFace,
        []
      );
      expect(view.labels.get(faceId)).toBe("Lato Regular");
      expect(
        view.options.scripts.find((option) => option.value === "Deva")
      ).toEqual({ count: 0, name: "Devanagari", value: "Deva" });
      expect(view.typingProblems).toEqual([
        '"invalid" is not a code point or a range. Write code points as U+0041 and ranges as U+0041-U+005A, with commas between them.',
      ]);
      expect(view.selections.map((selection) => selection.faceId)).toEqual([
        faceId,
      ]);
      expect(draft.scripts).toEqual(["Deva"]);
    } finally {
      workspace.close();
    }
  });

  it("has no chosen faces when every face in the draft has left the project", async () => {
    const workspace = testWorkspace();
    try {
      await importOne(workspace, fixtureFile("lato"));
      const view = planView(
        workspace.getState().project,
        startDraft("gone"),
        workspace.openFace,
        []
      );
      expect(view.chosen).toEqual([]);
      expect(view.selections).toEqual([]);
      expect(view.options.scripts).toEqual([]);
      expect(view.tags).toEqual([]);
    } finally {
      workspace.close();
    }
  });
});

describe("comparing plan drafts", () => {
  it("compares every ordered selection and typed field", () => {
    const draft = startDraft("face");
    expect(sameDraft(draft, { ...draft })).toBe(true);
    const changes = [
      { blocks: ["Basic Latin"] },
      { faceIds: ["other"] },
      { familyName: "Other" },
      { features: "chosen" as const },
      { featureTags: ["liga"] },
      { format: "woff2" as const },
      { keep: "selection" as const },
      { languages: ["en"] },
      { ranges: "U+0041" },
      { scripts: ["Latn"] },
      { sharedGroups: ["digits"] as const },
      { typed: "A" },
      { treatments: { face: { kind: "keep-variable" as const } } },
    ];
    for (const change of changes) {
      expect(sameDraft(draft, { ...draft, ...change })).toBe(false);
    }
    expect(
      sameDraft(
        { ...draft, scripts: ["Latn", "Grek"] },
        { ...draft, scripts: ["Grek", "Latn"] }
      )
    ).toBe(false);
  });

  it("compares pinned locations and style names without depending on object key order", () => {
    const draft = startDraft("face");
    const pinned = {
      ...draft,
      treatments: {
        face: {
          kind: "pinned" as const,
          location: { wdth: 100, wght: 400 },
          styleName: "Regular",
        },
      },
    };
    expect(
      sameDraft(pinned, {
        ...draft,
        treatments: {
          face: {
            kind: "pinned",
            location: { wdth: 100, wght: 400 },
            styleName: "Regular",
          },
        },
      })
    ).toBe(true);
    expect(
      sameDraft(pinned, {
        ...draft,
        treatments: {
          face: {
            kind: "pinned",
            location: { wdth: 100, wght: 500 },
            styleName: "Regular",
          },
        },
      })
    ).toBe(false);
    expect(
      sameDraft(pinned, {
        ...draft,
        treatments: {
          face: {
            kind: "pinned",
            location: { wdth: 100, wght: 400 },
            styleName: "Other",
          },
        },
      })
    ).toBe(false);
  });
});
