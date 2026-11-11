import { describe, expect, it } from "vitest";
import type { BuildRequest, BuiltFont } from "~/packaging/building";
import { buildWorkingFace, workingRequest } from "~/proof/working-build";
import { FIXED_TIME, fixedClock } from "../helpers/fixed";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const BUILT: BuiltFont = {
  bytes: Uint8Array.of(0, 1, 0, 0),
  characterCount: 1,
  glyphCount: 1,
  notes: [],
};

/** A builder that keeps what it was asked for and finishes when the test says so. */
const heldBuilder = () => {
  const requests: BuildRequest[] = [];
  let finish: () => void = () => undefined;
  return {
    build: (request: BuildRequest) => {
      requests.push(request);
      return new Promise<BuiltFont>((resolve) => {
        finish = () => resolve(BUILT);
      });
    },
    finish: () => finish(),
    requests,
  };
};

/** A workspace that holds Lato, with a widened A as its one applied change. */
const editedLato = async () => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  const widen = (advance: number) =>
    workspace.apply("Widen A", [
      {
        advance,
        faceId,
        glyph: { glyphId: 4, kind: "source" },
        kind: "advance-changed",
      },
    ]);
  widen(1400);
  return { faceId, widen, workspace };
};

describe("building a working face for a proof", () => {
  it("builds the face as the project has it and wraps the font with its time, id and samples", async () => {
    const { faceId, workspace } = await editedLato();
    const { project } = workspace.getState();
    const builder = heldBuilder();
    const building = buildWorkingFace({
      builder,
      clock: fixedClock,
      faceId,
      label: "Lato Regular",
      newId: () => "proof-1",
      workspace,
    });
    expect(builder.requests).toEqual([workingRequest(project, faceId)]);
    builder.finish();
    const { font, project: builtFrom } = await building;

    expect(builtFrom).toBe(project);
    expect(font).toMatchObject({
      builtAt: FIXED_TIME,
      bytes: BUILT.bytes,
      // A proof build is not renamed or checked against the licence.
      exported: false,
      faceId,
      fileName: "Lato Regular, working face",
      id: "proof-1",
      request: builder.requests[0],
    });
    // Lato is a Latin face, so its samples are Latin words it can set.
    expect(font.samples.map((kept) => kept.scriptName)).toContain("Latin");
    expect(font.samples.every((kept) => kept.sample.text.length > 0)).toBe(
      true
    );
  });

  it("says what the font was built from, whatever changes while it builds", async () => {
    const { faceId, widen, workspace } = await editedLato();
    const started = workspace.getState().project;
    const builder = heldBuilder();
    const building = buildWorkingFace({
      builder,
      clock: fixedClock,
      faceId,
      label: "Lato Regular",
      newId: () => "proof-1",
      workspace,
    });
    widen(1500);
    builder.finish();
    const { font, project } = await building;
    expect(project).toBe(started);
    expect(project).not.toBe(workspace.getState().project);
    expect(font.request).toEqual(workingRequest(started, faceId));
  });

  it("reads the clock when the font is built, not when it was asked for", async () => {
    const { faceId, workspace } = await editedLato();
    const builder = heldBuilder();
    let time = FIXED_TIME;
    const building = buildWorkingFace({
      builder,
      clock: () => new Date(time),
      faceId,
      label: "Lato Regular",
      newId: () => "proof-1",
      workspace,
    });
    time = "2026-11-10T09:00:07.000Z";
    builder.finish();
    expect((await building).font.builtAt).toBe("2026-11-10T09:00:07.000Z");
  });

  it("rejects for a face the project does not have, before anything is built", async () => {
    const { workspace } = await editedLato();
    const builder = heldBuilder();
    await expect(
      buildWorkingFace({
        builder,
        clock: fixedClock,
        faceId: "gone",
        label: "Gone",
        newId: () => "proof-1",
        workspace,
      })
    ).rejects.toThrow();
    expect(builder.requests).toEqual([]);
  });
});
