import { byCodeUnit } from "@foundry/lib/ordering";
import {
  scanDirectory,
  WorkspaceSourceUnavailableError,
} from "@foundry/workspaces";
import { nodeFileSystem, sha256Hex } from "@foundry/workspaces/node";
import { describe, expect, it, vi } from "vitest";

import type { EntryInputs } from "../substrate";

import { fixture } from "./helpers/directory";
import { required } from "./helpers/required";

const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0x1a]);
const byPath = <T extends { path: string }>(entries: readonly T[]) =>
  [...entries].sort(byCodeUnit((entry: T) => entry.path));

function largeTree(): EntryInputs {
  const entries: Record<string, EntryInputs[string]> = {
    "README.md": { bytes: "# top\n" },
  };
  for (let group = 0; group < 8; group += 1) {
    for (let index = 0; index < 8; index += 1) {
      entries[`src/group-${group}/module-${index}/index.ts`] = {
        bytes: `export const value = ${index};\n`,
      };
    }
    entries[`assets/group-${group}/icon.png`] = {
      bytes: new Uint8Array([...BINARY, group]),
    };
  }
  return entries;
}

describe("Artifact directory inventory", () => {
  it("creates a workspace file in the authoritative artifact without overwriting a sibling", async () => {
    const { artifacts, artifact, load } = await fixture({
      "existing.txt": { bytes: "keep" },
    });
    const workspace = await load();
    expect(
      await workspace.createFile({ path: "new.txt", text: "created" })
    ).toMatchObject({ catalog: "current", kind: "saved" });
    expect(
      await workspace.createFile({ path: "existing.txt", text: "replace" })
    ).toMatchObject({ kind: "failed" });
    const contentId = required(
      required(await artifacts.get(artifact.id)).contentId
    );
    expect(
      new TextDecoder().decode(
        required(await artifacts.readFile(contentId, "new.txt")).blob
      )
    ).toBe("created");
    expect(
      new TextDecoder().decode(
        required(await artifacts.readFile(contentId, "existing.txt")).blob
      )
    ).toBe("keep");
  });
  it("preserves empty directories and special entries without reading bytes during scans", async () => {
    const { artifacts, load } = await fixture({
      device: { type: "device" },
      empty: { type: "directory" },
      link: { target: "../missing", type: "symlink" },
      pipe: { type: "pipe" },
      socket: { type: "socket" },
    });
    const workspace = await load();
    const read = vi
      .spyOn(artifacts, "readFile")
      .mockRejectedValue(new Error("Scan read bytes"));
    expect(byPath(await workspace.scan())).toEqual([
      { name: "device", path: "device", type: "device" },
      { name: "empty", path: "empty", type: "directory" },
      { name: "link", path: "link", target: "../missing", type: "symlink" },
      { name: "pipe", path: "pipe", type: "pipe" },
      { name: "socket", path: "socket", type: "socket" },
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it("matches the Node scanner over a deeply nested 73-file tree", async () => {
    const { load } = await fixture(largeTree());
    const workspace = await load();
    const entries = await workspace.scan();
    expect(byPath(entries)).toEqual(
      byPath(await scanDirectory(nodeFileSystem, workspace.root))
    );
    expect(entries.filter((entry) => entry.type === "file")).toHaveLength(73);
  });

  it("scans metadata without opening a blob and ignores no curated entries", async () => {
    const { artifacts, load } = await fixture({
      ".gitignore": { bytes: "ignored.txt" },
      "ignored.txt": { bytes: "retained" },
      "page.bespoke": { bytes: "<p/>", mime: "text/html" },
    });
    const workspace = await load();
    const read = vi
      .spyOn(artifacts, "readFile")
      .mockRejectedValue(new Error("Unexpected read"));
    const range = vi
      .spyOn(artifacts, "readFileRange")
      .mockRejectedValue(new Error("Unexpected range"));
    const entries = await workspace.scan();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "ignored.txt", type: "file" }),
        expect.objectContaining({ mime: "text/html", path: "page.bespoke" }),
      ])
    );
    expect(read).not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled();
  });

  it("classifies files using the shared vocabulary", async () => {
    const { load } = await fixture({
      "media/logo.png": { bytes: BINARY },
      "src/app.ts": { bytes: "const a = 1;\n" },
    });
    const entries = await (await load()).scan();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extension: "ts",
          kind: "code",
          mime: "text/typescript",
          path: "src/app.ts",
        }),
        expect.objectContaining({
          digest: sha256Hex(BINARY),
          kind: "image",
          mime: "image/png",
          path: "media/logo.png",
        }),
      ])
    );
  });

  it.each(["generating", "failed"] as const)(
    "rejects unavailable %s Content",
    async (state) => {
      const { store, artifact, filesystem } = await fixture({
        "a.md": { bytes: "partial" },
      });
      const { path } = await filesystem.resolve({ artifactId: artifact.id });
      await store.transaction(async (transaction) => {
        const content = await transaction.getContent(
          required(artifact.content).id
        );
        await transaction.putContent({ ...required(content), state });
      });
      await expect(filesystem.tree(path)).rejects.toBeInstanceOf(
        WorkspaceSourceUnavailableError
      );
    }
  );

  it("represents an empty Artifact as an empty loadable directory", async () => {
    const { artifacts, system } = await fixture();
    const empty = await artifacts.create({ name: "Empty", type: "text/plain" });
    expect(
      await (await system.load({ artifactId: empty.id })).entries()
    ).toEqual([]);
  });

  it("preserves the catalog when observation fails", async () => {
    const { filesystem, load } = await fixture({
      "kept.md": { bytes: "retained" },
    });
    const workspace = await load();
    vi.spyOn(filesystem, "tree").mockRejectedValue(new Error("Store failed"));
    const view = await workspace.refresh();
    expect(view.source.kind).toBe("scan-failed");
    expect(view.entries).toHaveLength(1);
  });
});

describe("Artifact directory reads", () => {
  it("reads UTF-8 text and encoded byte lengths", async () => {
    const { load } = await fixture({ "intro.md": { bytes: "# héllo\n" } });
    const workspace = await load();
    const [file] = await workspace.files();
    expect(await workspace.read(required(file).id)).toMatchObject({
      bytes: new TextEncoder().encode("# héllo\n").byteLength,
      kind: "text",
      text: "# héllo\n",
    });
  });

  it("keeps binary bytes distinct from empty text", async () => {
    const { load } = await fixture({ "logo.png": { bytes: BINARY } });
    const workspace = await load();
    const [file] = await workspace.files();
    expect(await workspace.read(required(file).id)).toMatchObject({
      bytes: BINARY.byteLength,
      kind: "binary",
    });
  });

  it.each([
    ["text/plain", "text"],
    ["application/ld+json", "text"],
    ["application/octet-stream", "binary"],
    [null, "binary"],
  ] as const)(
    "preserves MIME-aware NUL handling for %s",
    async (mime, kind) => {
      const { load } = await fixture({
        data: { bytes: new Uint8Array([97, 0, 98]), mime },
      });
      const workspace = await load();
      const [file] = await workspace.files();
      expect(await workspace.read(required(file).id)).toMatchObject({ kind });
    }
  );

  it("refuses invalid UTF-8 even when MIME identifies text", async () => {
    const { load } = await fixture({
      data: { bytes: new Uint8Array([0xff]), mime: "text/plain" },
    });
    const workspace = await load();
    const [file] = await workspace.files();
    expect(await workspace.read(required(file).id)).toMatchObject({
      kind: "binary",
    });
  });

  it("reports corrupt byte resolution as unreadable", async () => {
    const { artifacts, load } = await fixture({ "a.md": { bytes: "a" } });
    const workspace = await load();
    const [file] = await workspace.files();
    vi.spyOn(artifacts, "readFile").mockRejectedValue(
      new Error("Corrupt blob")
    );
    expect(await workspace.read(required(file).id)).toMatchObject({
      kind: "unreadable",
    });
  });
});
