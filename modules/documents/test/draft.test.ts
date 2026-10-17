import { describe, expect, it } from "vitest";
import {
  answered,
  dirty,
  edit,
  keepMine,
  observed,
  opened,
  takeTheirs,
} from "../src/draft";

const base = { contentId: "c1", digest: "d1" };
const change = (digest: string, contentId = "c1") =>
  ({ contentId, entry: { digest }, kind: "change" }) as const;

describe("the editor Draft", () => {
  it("reloads a newer save while clean, and only surfaces it while editing", () => {
    const clean = opened(base, "saved");
    expect(observed(clean, change("d2"))).toMatchObject({
      reload: { contentId: "c1", digest: "d2" },
      removed: false,
    });

    const editing = edit(clean, "my unsaved text");
    const seen = observed(editing, change("d2"));
    expect(seen.reload).toBeNull();
    expect(seen.draft).toMatchObject({
      newer: { digest: "d2" },
      text: "my unsaved text",
    });
    expect(dirty(seen.draft)).toBe(true);
  });

  it("ignores the state it already has, as a reconnect snapshot repeats it", () => {
    const draft = opened(base, "saved");
    expect(
      observed(draft, { ...change("d1"), gap: false, kind: "snapshot" })
    ).toEqual({ draft, reload: null, removed: false });
  });

  it("keeps the Draft when the file is removed", () => {
    const editing = edit(opened(base, "saved"), "kept");
    expect(
      observed(editing, { contentId: null, entry: null, kind: "removed" })
    ).toEqual({ draft: editing, reload: null, removed: true });
  });

  it("keeps both versions on a conflict until the user picks one", () => {
    const editing = edit(opened(base, "base"), "mine");
    const lost = answered(editing, "mine", {
      current: { digest: "d9", text: "theirs" },
      kind: "conflict",
    });
    expect(lost).toMatchObject({
      conflict: { text: "theirs" },
      text: "mine",
    });
    expect(dirty(lost)).toBe(true);
    // Keeping mine bases it on theirs, so the next save replaces it on purpose.
    expect(keepMine(lost)).toMatchObject({
      base: { digest: "d9" },
      conflict: null,
      text: "mine",
    });
    expect(takeTheirs(lost)).toMatchObject({
      base: { digest: "d9" },
      saved: "theirs",
      text: "theirs",
    });
  });

  it("keeps edits typed while a save was in flight", () => {
    const sent = edit(opened(base, "a"), "ab");
    const typedOn = edit(sent, "abc");
    const saved = answered(typedOn, "ab", { digest: "d2", kind: "saved" });
    expect(saved).toMatchObject({
      base: { digest: "d2" },
      saved: "ab",
      text: "abc",
    });
    expect(dirty(saved)).toBe(true);
  });
});
