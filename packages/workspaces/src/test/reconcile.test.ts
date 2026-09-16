import { describe, expect, it } from "vitest";
import { diffCatalog, isEmptyChange } from "../reconcile";
import type { FileCandidate } from "../scanner";
import type { WorkspaceFileId, WorkspaceId } from "../workspace";
import type { StoredFileRecord } from "../workspace-store";

/**
 * The identity rules, without a filesystem.
 *
 * Every decision reconciliation makes about a File's id is decidable from the
 * prior rows and the candidate inventory alone, so the adversarial cases —
 * unique move, ambiguous move, an edit that only looks like a move — are
 * examined here rather than through a temporary directory.
 */

const WORKSPACE = "workspace-1" as WorkspaceId;
const AT = new Date(5000);
const BORN = new Date(1000);

function row(
  path: string,
  overrides: Partial<StoredFileRecord> = {}
): StoredFileRecord {
  return {
    checksum: `sum-${path}`,
    createdAt: BORN,
    extension: "md",
    id: `id-${path}` as WorkspaceFileId,
    kind: "document",
    mimeType: "text/markdown",
    name: path.split("/").at(-1) ?? path,
    path,
    size: 10,
    updatedAt: BORN,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function candidate(
  path: string,
  overrides: Partial<FileCandidate> = {}
): FileCandidate {
  return {
    checksum: `sum-${path}`,
    extension: "md",
    kind: "document",
    mimeType: "text/markdown",
    name: path.split("/").at(-1) ?? path,
    path,
    size: 10,
    ...overrides,
  };
}

let issued = 0;
function diff(
  existing: readonly StoredFileRecord[],
  candidates: readonly FileCandidate[]
) {
  return diffCatalog({
    at: AT,
    candidates,
    existing,
    newFileId: () => {
      issued += 1;
      return `new-${issued}` as WorkspaceFileId;
    },
    workspaceId: WORKSPACE,
  });
}

describe("diffCatalog", () => {
  it("writes nothing for a catalog that did not move", () => {
    const change = diff(
      [row("a.md"), row("b.md")],
      [candidate("a.md"), candidate("b.md")]
    );

    expect(isEmptyChange(change)).toBe(true);
  });

  it("keeps the id and birth of a File edited at the same path", () => {
    const before = row("a.md");

    const change = diff(
      [before],
      [candidate("a.md", { checksum: "edited", size: 3 })]
    );

    expect(change.inserted).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.updated).toEqual([
      { ...before, checksum: "edited", size: 3, updatedAt: AT },
    ]);
  });

  it("inserts arrivals and deletes departures", () => {
    const kept = row("a.md");
    const gone = row("b.md");

    const change = diff([kept, gone], [candidate("a.md"), candidate("c.md")]);

    expect(change.updated).toEqual([]);
    expect(change.deletedIds).toEqual([gone.id]);
    expect(change.inserted).toHaveLength(1);
    expect(change.inserted[0]).toMatchObject({
      createdAt: AT,
      path: "c.md",
      updatedAt: AT,
      workspaceId: WORKSPACE,
    });
    expect(change.inserted[0]?.id).not.toBe(gone.id);
  });

  it("preserves identity through a move only one story explains", () => {
    const before = row("src/notes.md", { checksum: "same", size: 7 });

    const change = diff(
      [before],
      [
        candidate("docs/notes.txt", {
          checksum: "same",
          extension: "txt",
          mimeType: "text/plain",
          size: 7,
        }),
      ]
    );

    expect(change.inserted).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.updated).toEqual([
      {
        ...before,
        extension: "txt",
        mimeType: "text/plain",
        name: "notes.txt",
        path: "docs/notes.txt",
        updatedAt: AT,
      },
    ]);
  });

  it("refuses to guess when two Files share one fingerprint", () => {
    const first = row("a.md", { checksum: "twin", size: 4 });
    const second = row("b.md", { checksum: "twin", size: 4 });

    const change = diff(
      [first, second],
      [
        candidate("moved/a.md", { checksum: "twin", size: 4 }),
        candidate("moved/b.md", { checksum: "twin", size: 4 }),
      ]
    );

    expect(change.updated).toEqual([]);
    expect(new Set(change.deletedIds)).toEqual(new Set([first.id, second.id]));
    expect(change.inserted.map((file) => file.path)).toEqual([
      "moved/a.md",
      "moved/b.md",
    ]);
    expect(change.inserted.map((file) => file.id)).not.toContain(first.id);
  });

  it("refuses a one-to-many and a many-to-one group alike", () => {
    const single = row("a.md", { checksum: "twin", size: 4 });

    const oneToMany = diff(
      [single],
      [
        candidate("x.md", { checksum: "twin", size: 4 }),
        candidate("y.md", { checksum: "twin", size: 4 }),
      ]
    );
    const manyToOne = diff(
      [single, row("b.md", { checksum: "twin", size: 4 })],
      [candidate("x.md", { checksum: "twin", size: 4 })]
    );

    expect(oneToMany.updated).toEqual([]);
    expect(oneToMany.deletedIds).toEqual([single.id]);
    expect(manyToOne.updated).toEqual([]);
    expect(manyToOne.deletedIds).toHaveLength(2);
    expect(manyToOne.inserted).toHaveLength(1);
  });

  it("never transfers identity between empty files", () => {
    const placeholder = row(".gitkeep", { checksum: "empty", size: 0 });

    const change = diff(
      [placeholder],
      [candidate("src/index.ts", { checksum: "empty", size: 0 })]
    );

    // One departure, one arrival, one shared fingerprint — the letter of the
    // move rule. But every zero-byte file has that fingerprint, so `.gitkeep`
    // and a new empty `index.ts` are not evidence of anything.
    expect(change.updated).toEqual([]);
    expect(change.deletedIds).toEqual([placeholder.id]);
    expect(change.inserted).toHaveLength(1);
    expect(change.inserted[0]?.id).not.toBe(placeholder.id);
    expect(change.inserted[0]?.createdAt).toBe(AT);
  });

  it("treats a copy as an arrival rather than a move", () => {
    const original = row("a.md", { checksum: "same", size: 6 });

    const change = diff(
      [original],
      [
        candidate("a.md", { checksum: "same", size: 6 }),
        candidate("copy.md", { checksum: "same", size: 6 }),
      ]
    );

    // The original still stands at its own path, so it is matched there and is
    // never a departure. The copy has nothing to have moved from.
    expect(change.updated).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.inserted.map((file) => file.path)).toEqual(["copy.md"]);
  });

  it("loses identity when a File is moved and edited in one observation", () => {
    const before = row("src/notes.md", { checksum: "before", size: 6 });

    const change = diff(
      [before],
      [candidate("docs/notes.md", { checksum: "after", size: 9 })]
    );

    // Nothing connects the two: the path moved and the bytes changed. This is
    // the documented ambiguous outcome, not a gap.
    expect(change.deletedIds).toEqual([before.id]);
    expect(change.inserted).toHaveLength(1);
    expect(change.updated).toEqual([]);
  });

  it("lets the path decide when bytes point somewhere else", () => {
    const staying = row("a.md", { checksum: "alpha", size: 5 });
    const renamed = row("b.md", { checksum: "beta", size: 4 });

    // `a.md` is deleted and `b.md` is renamed onto its path. The candidate at
    // `a.md` matches `a.md`'s row, so that row survives carrying b's content
    // and b's row is deleted — path beats byte evidence, deliberately. The
    // alternative makes every ordinary edit a deletion and a creation.
    const change = diff(
      [staying, renamed],
      [candidate("a.md", { checksum: "beta", size: 4 })]
    );

    expect(change.updated).toEqual([
      { ...staying, checksum: "beta", size: 4, updatedAt: AT },
    ]);
    expect(change.deletedIds).toEqual([renamed.id]);
    expect(change.inserted).toEqual([]);
  });

  it("does not call two different sizes at one checksum a move", () => {
    const before = row("a.md", { checksum: "same", size: 4 });

    const change = diff(
      [before],
      [candidate("b.md", { checksum: "same", size: 5 })]
    );

    expect(change.deletedIds).toEqual([before.id]);
    expect(change.inserted).toHaveLength(1);
  });

  it("applies an edit, an addition, a move, and a deletion at once", () => {
    const edited = row("README.md");
    const movedFrom = row("old/guide.md", { checksum: "guide", size: 9 });
    const removed = row("stale.md");

    const change = diff(
      [edited, movedFrom, removed],
      [
        candidate("README.md", { checksum: "fresh" }),
        candidate("docs/guide.md", { checksum: "guide", size: 9 }),
        candidate("added.md"),
      ]
    );

    expect(change.updated.map((file) => [file.id, file.path])).toEqual([
      [edited.id, "README.md"],
      [movedFrom.id, "docs/guide.md"],
    ]);
    expect(change.deletedIds).toEqual([removed.id]);
    expect(change.inserted.map((file) => file.path)).toEqual(["added.md"]);
  });
});
