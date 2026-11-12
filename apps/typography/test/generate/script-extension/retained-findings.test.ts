import { expect, it } from "vitest";
import { faceStateOf } from "~/generate/script-extension/session";
import { latoExtensionSession } from "./helpers/extension-session";

it("keeps each making with the project glyphs shown after redo", async () => {
  const { session, workspace, faceId } = await latoExtensionSession();
  expect(session.shown(faceId)).toBeUndefined();
  await session.listSource();
  await session.run(faceId);
  const first = session.shown(faceId);
  const firstId = faceStateOf(session.getState(), faceId).runId;
  session.add(faceId);
  workspace.undo();
  await session.run(faceId);
  const second = session.shown(faceId);
  const secondId = faceStateOf(session.getState(), faceId).runId;
  expect(secondId).not.toBe(firstId);
  expect(second?.findings).not.toBe(first?.findings);
  workspace.redo();
  const applied = session.shown(faceId);
  expect(applied?.findings).toBe(first?.findings);
  expect(applied?.shown.glyphs.map((glyph) => glyph.key)).toEqual(
    first?.shown.glyphs.map((glyph) => glyph.key)
  );
  expect(faceStateOf(session.getState(), faceId).runId).toBe(secondId);
  workspace.undo();
  expect(session.shown(faceId)?.findings).toBe(second?.findings);
  expect(session.shown(faceId)?.shown).toEqual(second?.shown);
});
