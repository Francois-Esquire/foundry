import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { diffCatalog, isEmptyChange } from "../reconcile";
import type {
  ObservedFacts,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceFile,
  WorkspaceId,
} from "../types";

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
  overrides: Partial<WorkspaceFile> = {}
): WorkspaceFile {
  return {
    bytes: 10,
    createdAt: BORN,
    digest: createHash("sha256").update(path).digest("hex"),
    extension: "md",
    id: `id-${path}` as WorkspaceEntryId,
    kind: "document",
    mime: "text/markdown",
    name: path.split("/").at(-1) ?? path,
    path,
    type: "file",
    updatedAt: BORN,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function candidate(
  path: string,
  overrides: Partial<Extract<ObservedFacts, { type: "file" }>> = {}
): ObservedFacts {
  return {
    bytes: 10,
    digest: createHash("sha256").update(path).digest("hex"),
    extension: "md",
    kind: "document",
    mime: "text/markdown",
    name: path.split("/").at(-1) ?? path,
    path,
    type: "file",
    ...overrides,
  };
}

let issued = 0;
function diff(
  existing: readonly WorkspaceEntry[],
  candidates: readonly ObservedFacts[]
) {
  const parents = new Set<string>();
  for (const entry of [...existing, ...candidates]) {
    let { path } = entry;
    while (path.includes("/")) {
      path = path.slice(0, path.lastIndexOf("/"));
      parents.add(path);
    }
  }
  const directories = [...parents].map((path) => ({
    createdAt: BORN,
    id: `directory-${path}` as WorkspaceEntryId,
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "directory" as const,
    updatedAt: BORN,
    workspaceId: WORKSPACE,
  }));
  return diffCatalog({
    at: AT,
    candidates: [...directories, ...candidates],
    existing: [...directories, ...existing],
    newEntryId: () => {
      issued += 1;
      return `new-${issued}` as WorkspaceEntryId;
    },
    workspaceId: WORKSPACE,
  });
}

describe("diffCatalog", () => {
  it("keeps path identity across entry types without carrying obsolete metadata", () => {
    const file = row("entry");
    const observations: ObservedFacts[] = [
      { name: "entry", path: "entry", target: "../missing", type: "symlink" },
      { name: "entry", path: "entry", type: "directory" },
      { name: "entry", path: "entry", type: "socket" },
      candidate("entry"),
    ];
    let before: WorkspaceEntry = file;
    for (const observed of observations) {
      const change = diff([before], [observed]);
      expect(change.inserted).toEqual([]);
      expect(change.deletedIds).toEqual([]);
      const expected = {
        ...observed,
        createdAt: BORN,
        id: file.id,
        updatedAt: AT,
        workspaceId: WORKSPACE,
      };
      expect(change.updated).toEqual([expected]);
      before = expected;
    }
  });

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
      [
        candidate("a.md", {
          bytes: 3,
          digest:
            "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618",
        }),
      ]
    );

    expect(change.inserted).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.updated).toEqual([
      {
        ...before,
        bytes: 3,
        digest:
          "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618",
        updatedAt: AT,
      },
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
    const before = row("src/notes.md", {
      bytes: 7,
      digest:
        "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
    });

    const change = diff(
      [before],
      [
        candidate("docs/notes.txt", {
          bytes: 7,
          digest:
            "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
          extension: "txt",
          mime: "text/plain",
          type: "file" as const,
        }),
      ]
    );

    expect(change.inserted).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.updated).toEqual([
      {
        ...before,
        extension: "txt",
        mime: "text/plain",
        name: "notes.txt",
        path: "docs/notes.txt",
        updatedAt: AT,
      },
    ]);
  });

  it("refuses to guess when two Files share one fingerprint", () => {
    const first = row("a.md", {
      bytes: 4,
      digest:
        "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
    });
    const second = row("b.md", {
      bytes: 4,
      digest:
        "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
    });

    const change = diff(
      [first, second],
      [
        candidate("moved/a.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
        candidate("moved/b.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
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
    const single = row("a.md", {
      bytes: 4,
      digest:
        "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
    });

    const oneToMany = diff(
      [single],
      [
        candidate("x.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
        candidate("y.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
      ]
    );
    const manyToOne = diff(
      [
        single,
        row("b.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
      ],
      [
        candidate("x.md", {
          bytes: 4,
          digest:
            "72b33a1cb0bfc9cdd3db0102962414c7a0d85aad94eba64cd8c33265242f7f9f",
        }),
      ]
    );

    expect(oneToMany.updated).toEqual([]);
    expect(oneToMany.deletedIds).toEqual([single.id]);
    expect(manyToOne.updated).toEqual([]);
    expect(manyToOne.deletedIds).toHaveLength(2);
    expect(manyToOne.inserted).toHaveLength(1);
  });

  it("never transfers identity between empty files", () => {
    const placeholder = row(".gitkeep", {
      bytes: 0,
      digest:
        "2e1cfa82b035c26cbbbdae632cea070514eb8b773f616aaeaf668e2f0be8f10d",
    });

    const change = diff(
      [placeholder],
      [
        candidate("src/index.ts", {
          bytes: 0,
          digest:
            "2e1cfa82b035c26cbbbdae632cea070514eb8b773f616aaeaf668e2f0be8f10d",
        }),
      ]
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
    const original = row("a.md", {
      bytes: 6,
      digest:
        "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
    });

    const change = diff(
      [original],
      [
        candidate("a.md", {
          bytes: 6,
          digest:
            "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
        }),
        candidate("copy.md", {
          bytes: 6,
          digest:
            "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
        }),
      ]
    );

    // The original still stands at its own path, so it is matched there and is
    // never a departure. The copy has nothing to have moved from.
    expect(change.updated).toEqual([]);
    expect(change.deletedIds).toEqual([]);
    expect(change.inserted.map((file) => file.path)).toEqual(["copy.md"]);
  });

  it("loses identity when a File is moved and edited in one observation", () => {
    const before = row("src/notes.md", {
      bytes: 6,
      digest:
        "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
    });

    const change = diff(
      [before],
      [
        candidate("docs/notes.md", {
          bytes: 9,
          digest:
            "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
        }),
      ]
    );

    // Nothing connects the two: the path moved and the bytes changed. This is
    // the documented ambiguous outcome, not a gap.
    expect(change.deletedIds).toEqual([before.id]);
    expect(change.inserted).toHaveLength(1);
    expect(change.updated).toEqual([]);
  });

  it("lets the path decide when bytes point somewhere else", () => {
    const staying = row("a.md", {
      bytes: 5,
      digest:
        "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
    });
    const renamed = row("b.md", {
      bytes: 4,
      digest:
        "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
    });

    // `a.md` is deleted and `b.md` is renamed onto its path. The candidate at
    // `a.md` matches `a.md`'s row, so that row survives carrying b's content
    // and b's row is deleted — path beats byte evidence, deliberately. The
    // alternative makes every ordinary edit a deletion and a creation.
    const change = diff(
      [staying, renamed],
      [
        candidate("a.md", {
          bytes: 4,
          digest:
            "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
        }),
      ]
    );

    expect(change.updated).toEqual([
      {
        ...staying,
        bytes: 4,
        digest:
          "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
        updatedAt: AT,
      },
    ]);
    expect(change.deletedIds).toEqual([renamed.id]);
    expect(change.inserted).toEqual([]);
  });

  it("does not call two different sizes at one digest a move", () => {
    const before = row("a.md", {
      bytes: 4,
      digest:
        "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
    });

    const change = diff(
      [before],
      [
        candidate("b.md", {
          bytes: 5,
          digest:
            "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
        }),
      ]
    );

    expect(change.deletedIds).toEqual([before.id]);
    expect(change.inserted).toHaveLength(1);
  });

  it("applies an edit, an addition, a move, and a deletion at once", () => {
    const edited = row("README.md");
    const movedFrom = row("old/guide.md", {
      bytes: 9,
      digest:
        "83ca68be6227af2feb15f227485ed18aff8ecae99416a4bd6df3be1b5e8059b4",
    });
    const removed = row("stale.md");

    const change = diff(
      [edited, movedFrom, removed],
      [
        candidate("README.md", {
          digest:
            "d098ab5e44b9aabb755f76d806598f43573c662b35e4a2eab1e312ec9ad195e2",
        }),
        candidate("docs/guide.md", {
          bytes: 9,
          digest:
            "83ca68be6227af2feb15f227485ed18aff8ecae99416a4bd6df3be1b5e8059b4",
        }),
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
