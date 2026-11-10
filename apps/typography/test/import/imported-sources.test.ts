import { describe, expect, it } from "vitest";
import {
  describeWork,
  hasWork,
  sourceRows,
  summariseImport,
} from "~/import/imported-sources";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("sourceRows", () => {
  it("lists each source font with its file, family, faces and size", async () => {
    const workspace = testWorkspace();
    await workspace.importFonts([fixtureFile("lato"), fixtureFile("sofia")]);
    const rows = sourceRows(workspace.getState().project);
    expect(
      rows.map(({ faces, family, fileName }) => ({ faces, family, fileName }))
    ).toEqual([
      { faces: "Regular", family: "Lato", fileName: "Lato-Regular.ttf" },
      {
        faces: "Regular, variable",
        family: "Sofia Sans",
        fileName: "SofiaSans-wght.ttf",
      },
    ]);
    expect(rows[0]?.byteLength).toBe(fontBytes("lato").byteLength);
    expect(rows.every((row) => !hasWork(row.usage))).toBe(true);
  });

  it("counts pinned instances apart from the faces read from the file", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("sofia"));
    workspace.pinInstance(faceId, { wght: 700 }, "Bold");
    expect(sourceRows(workspace.getState().project)[0]?.faces).toBe(
      "Regular, variable; 1 pinned instance"
    );
  });

  it("reports the work that removing a font would lose", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    workspace.apply("Widen A", [
      {
        advance: 1500,
        faceId,
        glyph: { glyphId: 3, kind: "source" },
        kind: "advance-changed",
      },
    ]);
    workspace.propose([
      {
        advance: 1200,
        characters: [0x9_15],
        faceId,
        id: "candidate",
        name: "ka-deva",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    const [row] = sourceRows(workspace.getState().project);
    expect(row && hasWork(row.usage)).toBe(true);
    expect(row && describeWork(row.usage)).toBe(
      "1 applied change and 1 proposed candidate"
    );
  });
});

describe("summariseImport", () => {
  it("counts what was imported", () => {
    expect(
      summariseImport([
        {
          faceIds: ["a"],
          fileName: "a.ttf",
          sourceId: "a",
          status: "imported",
        },
        {
          faceIds: ["b"],
          fileName: "b.ttf",
          sourceId: "b",
          status: "imported",
        },
      ])
    ).toBe("2 fonts imported.");
  });

  it("counts duplicates and unreadable files without stopping at them", () => {
    expect(
      summariseImport([
        {
          faceIds: ["a"],
          fileName: "a.ttf",
          sourceId: "a",
          status: "imported",
        },
        { fileName: "a-copy.ttf", sourceId: "a", status: "duplicate" },
        { fileName: "notes.ttf", reason: "Not a font.", status: "rejected" },
      ])
    ).toBe(
      "1 font imported. 1 file was already in the project. 1 file could not be read, for the reasons given above."
    );
  });

  it("says plainly when nothing came in", () => {
    expect(
      summariseImport([
        { fileName: "notes.ttf", reason: "Not a font.", status: "rejected" },
        { fileName: "empty.otf", reason: "Empty.", status: "rejected" },
      ])
    ).toBe(
      "0 fonts imported. 2 files could not be read, for the reasons given above."
    );
  });
});
