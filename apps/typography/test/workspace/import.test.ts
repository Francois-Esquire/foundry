import { describe, expect, it } from "vitest";
import { FIXED_TIME } from "../helpers/fixed";
import { FONTS, fontBytes } from "../helpers/fixtures";
import {
  collectionOf,
  cutShort,
  emptyFile,
  textFile,
  withCorruptedDirectory,
} from "../helpers/font-files";
import {
  countingReader,
  fixtureFile,
  importOne,
  testWorkspace,
} from "../helpers/workspace";

describe("importFonts", () => {
  it("adds each good file as a source font with its face", async () => {
    const workspace = testWorkspace();
    const reports = await workspace.importFonts([
      fixtureFile("lato"),
      fixtureFile("sofia"),
    ]);
    const { activeFaceId, notices, project } = workspace.getState();
    expect(reports.map((report) => report.status)).toEqual([
      "imported",
      "imported",
    ]);
    expect(project.sources.map((source) => source.fileName)).toEqual([
      FONTS.lato,
      FONTS.sofia,
    ]);
    expect(project.sources[0]?.importedAt).toBe(FIXED_TIME);
    expect(project.faces.map((face) => face.description.familyName)).toEqual([
      "Lato",
      "Sofia Sans",
    ]);
    expect(activeFaceId).toBe(project.faces[0]?.id);
    expect(notices).toEqual([]);
  });

  it("records that the app made a file itself, and not for a file a person imported", async () => {
    const workspace = testWorkspace();
    await workspace.importFonts([
      fixtureFile("lato"),
      { ...fixtureFile("hebrew"), madeFor: "reconstruction" },
    ]);
    expect(
      workspace.getState().project.sources.map((source) => source.madeFor)
    ).toEqual([undefined, "reconstruction"]);
  });

  it("keeps the active face when more fonts arrive", async () => {
    const workspace = testWorkspace();
    const first = await importOne(workspace, fixtureFile("hebrew"));
    await importOne(workspace, fixtureFile("postscript"));
    expect(workspace.getState().activeFaceId).toBe(first.faceId);
  });

  it("turns each bad file into a notice and carries on with the batch", async () => {
    const workspace = testWorkspace();
    const reports = await workspace.importFonts([
      { bytes: emptyFile(), name: "empty.ttf" },
      { bytes: textFile(), name: "notes.ttf" },
      { bytes: cutShort(fontBytes("lato")), name: "half.ttf" },
      {
        bytes: withCorruptedDirectory(fontBytes("lato")),
        name: "scrambled.ttf",
      },
      fixtureFile("hebrew"),
    ]);
    expect(
      reports.map((report) =>
        report.status === "rejected" ? report.reason : report.status
      )
    ).toEqual([
      "This file is empty.",
      "This file is not a TrueType or OpenType font.",
      "This font file is cut short.",
      "This file has no glyphs to read.",
      "imported",
    ]);
    const { notices, project } = workspace.getState();
    expect(notices.map((notice) => notice.tone)).toEqual([
      "error",
      "error",
      "error",
      "error",
    ]);
    expect(notices[1]?.message).toBe(
      "Could not import notes.ttf. This file is not a TrueType or OpenType font. Check the file and import it again, or choose another font."
    );
    expect(notices[2]?.message).toContain("half.ttf");
    expect(project.sources.map((source) => source.fileName)).toEqual([
      FONTS.hebrew,
    ]);
    expect(
      workspace.openFace(project.faces[0]?.id ?? "").shape("שלום").direction
    ).toBe("rtl");
  });

  it("reports a file that is already imported, under any name", async () => {
    const workspace = testWorkspace();
    const first = await importOne(workspace, fixtureFile("hebrew"));
    const reports = await workspace.importFonts([
      fixtureFile("hebrew"),
      { bytes: fontBytes("hebrew"), name: "copy.ttf" },
    ]);
    expect(reports).toEqual([
      { fileName: FONTS.hebrew, sourceId: first.sourceId, status: "duplicate" },
      { fileName: "copy.ttf", sourceId: first.sourceId, status: "duplicate" },
    ]);
    const { notices, project } = workspace.getState();
    expect(project.sources).toHaveLength(1);
    expect(project.faces).toHaveLength(1);
    expect(notices.map(({ message, tone }) => ({ message, tone }))).toEqual([
      { message: `${FONTS.hebrew} is already imported.`, tone: "info" },
      {
        message: `copy.ttf is already imported. It is the same file as ${FONTS.hebrew}.`,
        tone: "info",
      },
    ]);
  });

  it("imports the same bytes once when they appear twice in one batch", async () => {
    const { counts, reader } = countingReader();
    const workspace = testWorkspace(reader);
    const reports = await workspace.importFonts([
      fixtureFile("hebrew"),
      fixtureFile("hebrew"),
    ]);
    expect(reports.map((report) => report.status)).toEqual([
      "imported",
      "duplicate",
    ]);
    expect(counts).toEqual({ closed: 1, opened: 2 });
  });

  it("imports the same bytes once when two imports overlap", async () => {
    const workspace = testWorkspace();
    const [first, second] = await Promise.all([
      workspace.importFonts([fixtureFile("hebrew")]),
      workspace.importFonts([fixtureFile("hebrew")]),
    ]);
    expect([first[0]?.status, second[0]?.status].sort()).toEqual([
      "duplicate",
      "imported",
    ]);
    expect(workspace.getState().project.sources).toHaveLength(1);
  });

  it("keeps a change made while a file is being digested", async () => {
    const workspace = testWorkspace();
    const importing = workspace.importFonts([fixtureFile("hebrew")]);
    workspace.renameProject("Renamed during import");
    await importing;
    const { project } = workspace.getState();
    expect(project.name).toBe("Renamed during import");
    expect(project.sources).toHaveLength(1);
  });

  it("yields one face per member of a font collection", async () => {
    const workspace = testWorkspace();
    const collection = collectionOf([
      fontBytes("hebrew"),
      fontBytes("postscript"),
    ]);
    const { faceIds, sourceId } = await importOne(workspace, {
      bytes: collection,
      name: "pair.ttc",
    });
    const { project } = workspace.getState();
    expect(faceIds).toHaveLength(2);
    expect(
      project.faces.map(({ description, index, sourceId: from }) => ({
        family: description.familyName,
        from,
        index,
        outlines: description.outlineFormat,
      }))
    ).toEqual([
      { family: "David Libre", from: sourceId, index: 0, outlines: "truetype" },
      { family: "Source Code Pro", from: sourceId, index: 1, outlines: "cff" },
    ]);
    const second = workspace.openFace(faceIds[1] ?? "");
    expect(second.description.familyName).toBe("Source Code Pro");
    expect(second.glyphForCharacter(0x41)).toBeDefined();
  });

  it("rejects a collection whole when one member cannot be read", async () => {
    const { counts, reader } = countingReader();
    const workspace = testWorkspace(reader);
    const collection = collectionOf([
      fontBytes("hebrew"),
      withCorruptedDirectory(fontBytes("postscript")),
    ]);
    const [report] = await workspace.importFonts([
      { bytes: collection, name: "broken.ttc" },
    ]);
    expect(report).toEqual({
      fileName: "broken.ttc",
      reason: "This file has no glyphs to read.",
      status: "rejected",
    });
    expect(workspace.getState().project.sources).toEqual([]);
    expect(counts.closed).toBe(1);
  });
});
