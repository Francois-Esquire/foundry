import { describe, expect, it } from "vitest";
import { characterShape, inspectCharacter } from "~/explorer/inspection";
import { readFaceCoverage } from "~/library/face-coverage";
import { TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const KA = 0x9_15;

const lato = async () => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  const read = (codePoint: number) => {
    const { project } = workspace.getState();
    const { classify } = readFaceCoverage(
      project,
      faceId,
      workspace.openFace(faceId)
    ).classification;
    const status = classify(codePoint);
    return {
      inspection: inspectCharacter(
        workspace,
        project,
        faceId,
        codePoint,
        status
      ),
      shape: characterShape(workspace, project, faceId, codePoint, status),
      status,
    };
  };
  return { faceId, read, workspace };
};

describe("inspectCharacter", () => {
  it("shows the source glyph a character maps to, with its id, name, advance and bounds", async () => {
    const { faceId, read, workspace } = await lato();
    const { inspection, shape } = read(0x41);
    const face = workspace.openFace(faceId);
    const glyphId = face.glyphForCharacter(0x41) ?? 0;
    expect(inspection.status).toBe("source");
    expect(inspection.glyph?.identity).toBe(`Glyph ${glyphId}`);
    expect(inspection.glyph?.name).toBe(face.glyphName(glyphId));
    expect(inspection.glyph?.advance).toBe(shape?.advance);
    expect(inspection.glyph?.bounds?.yMin).toBe(0);
    expect(inspection.glyph?.provenance).toBeUndefined();
  });

  it("lists the other characters that share the glyph, and never the character itself", async () => {
    const { faceId, read, workspace } = await lato();
    const face = workspace.openFace(faceId);
    const shared = [...face.characters()].find(
      (codePoint) =>
        face.charactersForGlyph(face.glyphForCharacter(codePoint) ?? 0).length >
        1
    );
    if (shared === undefined) {
      throw new Error("Lato should map two characters to one glyph.");
    }
    const others = face
      .charactersForGlyph(face.glyphForCharacter(shared) ?? 0)
      .filter((codePoint) => codePoint !== shared);
    expect(read(shared).inspection.glyph?.sharedWith).toEqual(others);
  });

  it("has no glyph for a character the face lacks", async () => {
    const { read } = await lato();
    const { inspection, shape } = read(KA);
    expect(inspection).toEqual({
      codePoint: KA,
      glyph: undefined,
      status: "missing",
    });
    expect(shape).toBeUndefined();
  });

  it("shows a proposed design as a candidate with its provenance, outside the face", async () => {
    const { faceId, read, workspace } = await lato();
    workspace.propose([
      {
        advance: 1200,
        characters: [KA],
        faceId,
        id: "candidate-ka",
        name: "ka-deva",
        outline: TRIANGLE,
        provenance: {
          createdAt: "2026-11-10T09:00:00.000Z",
          origin: "generated",
          recorded: true,
          runId: "run",
          strategy: "procedural",
        },
      },
    ]);
    const { inspection, shape } = read(KA);
    expect(inspection.status).toBe("candidate");
    expect(inspection.glyph).toMatchObject({
      advance: 1200,
      identity: "Candidate",
      name: "ka-deva",
      outline: TRIANGLE,
    });
    expect(inspection.glyph?.provenance?.origin).toBe("generated");
    expect(shape?.outline).toBe(TRIANGLE);
  });

  it("shows an accepted glyph as added, drawn from the working face", async () => {
    const { faceId, read, workspace } = await lato();
    workspace.propose([
      {
        advance: 1200,
        characters: [KA],
        faceId,
        id: "candidate-ka",
        name: "ka-deva",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    workspace.acceptCandidate("candidate-ka");
    const { inspection } = read(KA);
    expect(inspection.status).toBe("added");
    expect(inspection.glyph).toMatchObject({
      advance: 1200,
      identity: "Added glyph",
      name: "ka-deva",
      provenance: { origin: "manual" },
    });
  });

  it("shows an edited source glyph with the edit, not the source shape", async () => {
    const { faceId, read, workspace } = await lato();
    const glyphId = workspace.openFace(faceId).glyphForCharacter(0x41) ?? 0;
    workspace.apply("Redraw A", [
      {
        faceId,
        glyph: { glyphId, kind: "source" },
        kind: "outline-replaced",
        outline: TRIANGLE,
      },
    ]);
    const { inspection } = read(0x41);
    expect(inspection.status).toBe("edited");
    expect(inspection.glyph?.outline).toBe(TRIANGLE);
    expect(inspection.glyph?.identity).toBe(`Glyph ${glyphId}`);
  });
});
