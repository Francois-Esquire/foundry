import { describe, expect, it, vi } from "vitest";
import { sourceGlyph } from "~/typeface/changes";
import { ProjectError } from "~/typeface/project";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("notices", () => {
  it("turns a domain error into a notice and a failed outcome", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("sofia"));
    const before = workspace.getState().project;
    const outcome = workspace.apply("Edit a variable face", [
      { advance: 700, faceId, glyph: sourceGlyph(3), kind: "advance-changed" },
    ]);
    const notice = {
      id: "id-2",
      message: "Pin an instance of this variable face before editing it.",
      tone: "error",
    };
    expect(outcome).toEqual({ notice, ok: false });
    expect(workspace.getState().notices).toEqual([notice]);
    expect(workspace.getState().project).toBe(before);
  });

  it("fails every candidate and face use case the same way", () => {
    const workspace = testWorkspace();
    expect(workspace.acceptCandidate("nope").ok).toBe(false);
    expect(workspace.rejectCandidate("nope").ok).toBe(false);
    expect(workspace.setActiveFace("nope").ok).toBe(false);
    expect(workspace.pinInstance("nope", {}, "Bold").ok).toBe(false);
    expect(workspace.removeSource("nope").ok).toBe(false);
    expect(
      workspace.getState().notices.map((notice) => notice.message)
    ).toEqual([
      "This project has no candidate nope.",
      "This project has no face nope.",
      "This project has no source font nope.",
    ]);
    expect(workspace.getState().activeFaceId).toBeUndefined();
  });

  it("shows a repeated message once and hands back the notice on screen", () => {
    const workspace = testWorkspace();
    const first = workspace.acceptCandidate("nope");
    const second = workspace.acceptCandidate("nope");
    expect(workspace.getState().notices).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("dismisses one notice and leaves the rest", () => {
    const workspace = testWorkspace();
    workspace.acceptCandidate("one");
    workspace.acceptCandidate("two");
    const [first, second] = workspace.getState().notices;
    workspace.dismissNotice(first?.id ?? "");
    expect(workspace.getState().notices).toEqual([second]);
    const snapshot = workspace.getState();
    workspace.dismissNotice("unknown");
    expect(workspace.getState()).toBe(snapshot);
  });

  it("renames the project, and asks for a name when given none", () => {
    const workspace = testWorkspace();
    expect(workspace.renameProject("  Hebrew revival ").ok).toBe(true);
    expect(workspace.getState().project.name).toBe("Hebrew revival");
    expect(workspace.renameProject("   ").ok).toBe(false);
    expect(workspace.getState().project.name).toBe("Hebrew revival");
    expect(workspace.getState().notices[0]?.message).toBe(
      "A project needs a name. Type one and try again."
    );
  });

  it("tells subscribers about each new snapshot and nothing else", async () => {
    const workspace = testWorkspace();
    const listener = vi.fn();
    const unsubscribe = workspace.subscribe(listener);
    const initial = workspace.getState();

    workspace.undo();
    workspace.redo();
    workspace.checkout(4);
    expect(listener).not.toHaveBeenCalled();
    expect(workspace.getState()).toBe(initial);

    const { faceId } = await importOne(workspace, fixtureFile("hebrew"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(workspace.getState()).not.toBe(initial);
    expect(initial.project.sources).toEqual([]);

    workspace.setActiveFace(faceId);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    workspace.renameProject("Quiet");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets the reading helpers throw for an unknown face without a notice", () => {
    const workspace = testWorkspace();
    expect(() => workspace.openFace("nope")).toThrow(ProjectError);
    expect(() => workspace.glyphsOf("nope")).toThrow(ProjectError);
    expect(() => workspace.glyphForCharacter("nope", 0x41)).toThrow(
      ProjectError
    );
    expect(() => workspace.workingGlyph("nope", sourceGlyph(1))).toThrow(
      ProjectError
    );
    expect(workspace.getState().notices).toEqual([]);
  });
});
