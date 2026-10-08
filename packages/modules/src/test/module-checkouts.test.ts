import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Artifacts, EntryInputs } from "@foundry/artifacts";
import { contentIdSchema } from "@foundry/artifacts";
import { afterAll, describe, expect, it } from "vitest";

import { createModuleCheckouts, ModuleCheckoutError } from "../node/checkouts";
import { MODULE_CONTENT_MANIFEST_PATH } from "../version";
import { moduleFixture, VALID_MANIFEST } from "./helpers/module-fixture";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

const FILES: EntryInputs = {
  "outputs/empty": { type: "directory" },
  "outputs/packages/app/dist/index.html": { bytes: "<main></main>" },
  "outputs/program/server.js": { bytes: "export const server = 1;" },
  [MODULE_CONTENT_MANIFEST_PATH]: { bytes: JSON.stringify(VALID_MANIFEST) },
  "source/src/index.ts": { bytes: "export {};" },
};

async function fixture(files: EntryInputs = FILES) {
  const root = path.join(
    await mkdtemp(path.join(tmpdir(), "foundry-module-checkouts-")),
    "checkouts"
  );
  directories.push(path.dirname(root));
  const { system, content } = await moduleFixture({ files });
  const version = { contentId: content.id, digest: content.digest };
  return { content, root, system, version };
}

async function tree(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(`${next}/`, ...(await tree(root, next)));
    } else {
      found.push(next);
    }
  }
  return found.sort();
}

describe("Module program checkouts", () => {
  it("fills only the outputs tree, byte for byte, under the Content digest", async () => {
    const { root, system, content, version } = await fixture();
    const checkouts = createModuleCheckouts({ artifacts: system, root });

    const { hostPath } = await checkouts.ensure({ version });

    expect(hostPath).toBe(path.join(root, content.digest));
    expect(await tree(hostPath)).toEqual([
      "outputs/",
      "outputs/empty/",
      "outputs/packages/",
      "outputs/packages/app/",
      "outputs/packages/app/dist/",
      "outputs/packages/app/dist/index.html",
      "outputs/program/",
      "outputs/program/server.js",
    ]);
    expect(
      await readFile(path.join(hostPath, "outputs/program/server.js"), "utf8")
    ).toBe("export const server = 1;");
    expect(
      // biome-ignore lint/suspicious/noBitwiseOperators: masks file permission bits
      (await stat(path.join(hostPath, "outputs/program/server.js"))).mode &
        0o222
    ).toBe(0);
    expect(await readdir(root)).toEqual([content.digest]);
  });

  it("reuses a verified checkout, shared by every Installation of the version", async () => {
    const { root, system, version } = await fixture();
    const checkouts = createModuleCheckouts({ artifacts: system, root });
    const first = await checkouts.ensure({ version });
    const before = await stat(first.hostPath);

    const second = await checkouts.ensure({ version });

    expect(second).toEqual(first);
    expect((await stat(second.hostPath)).ino).toBe(before.ino);
    expect(await readdir(root)).toHaveLength(1);
  });

  it.each([
    [
      "changed bytes",
      async (hostPath: string) => {
        const target = path.join(hostPath, "outputs/program/server.js");
        await chmod(target, 0o644);
        await writeFile(target, "tampered");
      },
    ],
    [
      "an extra file",
      (hostPath: string) =>
        writeFile(path.join(hostPath, "outputs/injected.js"), "extra"),
    ],
    [
      "a missing file",
      (hostPath: string) =>
        rm(path.join(hostPath, "outputs/program/server.js"), { force: true }),
    ],
    [
      "a missing empty directory",
      (hostPath: string) =>
        rm(path.join(hostPath, "outputs/empty"), { recursive: true }),
    ],
    [
      "an extra empty directory",
      (hostPath: string) => mkdir(path.join(hostPath, "outputs/extra")),
    ],
  ])(
    "moves a checkout with %s aside and refills it",
    async (_name, corrupt) => {
      const { root, system, content, version } = await fixture();
      const checkouts = createModuleCheckouts({ artifacts: system, root });
      const { hostPath } = await checkouts.ensure({ version });
      await corrupt(hostPath);

      await expect(checkouts.ensure({ version })).resolves.toEqual({
        hostPath,
      });
      expect(
        await readFile(path.join(hostPath, "outputs/program/server.js"), "utf8")
      ).toBe("export const server = 1;");
      expect(await tree(hostPath)).not.toContain("outputs/injected.js");
      expect(await tree(hostPath)).not.toContain("outputs/extra/");
      expect(await tree(hostPath)).toContain("outputs/empty/");
      const entries = await readdir(root);
      expect(entries).toContain(content.digest);
      expect(
        entries.filter((entry) => entry.startsWith(".corrupt-"))
      ).toHaveLength(1);
    }
  );

  it("publishes once under concurrent starts and never exposes a partial tree", async () => {
    const { root, system, content, version } = await fixture();
    const checkouts = createModuleCheckouts({ artifacts: system, root });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => checkouts.ensure({ version }))
    );

    expect(new Set(results.map(({ hostPath }) => hostPath))).toEqual(
      new Set([path.join(root, content.digest)])
    );
    expect(await readdir(root)).toEqual([content.digest]);
    expect(await tree(results[0]?.hostPath ?? "")).toContain(
      "outputs/packages/app/dist/index.html"
    );
  });

  it("refuses bytes that do not match the Content and publishes nothing", async () => {
    const { root, system, version } = await fixture();
    const artifacts: Pick<Artifacts, "getContent" | "readFile"> = {
      getContent: (contentId) => system.getContent(contentId),
      readFile: async (contentId, filePath) => {
        const file = await system.readFile(contentId, filePath);
        return file === null || !filePath.endsWith("server.js")
          ? file
          : { ...file, blob: new TextEncoder().encode("substituted") };
      },
    };
    const checkouts = createModuleCheckouts({ artifacts, root });

    await expect(checkouts.ensure({ version })).rejects.toThrow(
      "failed byte verification"
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a missing, mutable, or digest-mismatched Content and one with no outputs", async () => {
    const { root, system, content, version } = await fixture();
    const checkouts = createModuleCheckouts({ artifacts: system, root });
    await expect(
      checkouts.ensure({
        version: { ...version, contentId: contentIdSchema.parse("missing") },
      })
    ).rejects.toBeInstanceOf(ModuleCheckoutError);
    await expect(
      checkouts.ensure({ version: { ...version, digest: "other" } })
    ).rejects.toBeInstanceOf(ModuleCheckoutError);
    const ready = await system.revise({
      artifactId: content.artifactId,
      contentId: content.id,
      expectedUpdatedAt: content.updatedAt,
    });
    await expect(
      checkouts.ensure({
        version: { contentId: ready.id, digest: ready.digest },
      })
    ).rejects.toBeInstanceOf(ModuleCheckoutError);

    const sourceOnly = await fixture({
      "source/src/index.ts": { bytes: "export {};" },
    });
    await expect(
      createModuleCheckouts({
        artifacts: sourceOnly.system,
        root: sourceOnly.root,
      }).ensure({ version: sourceOnly.version })
    ).rejects.toThrow("no runnable outputs");
    await expect(
      checkouts.ensure({ signal: AbortSignal.abort(), version })
    ).rejects.toThrow();
  });
});
