import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { captureModuleWorkspaceSource as captureNodeSource } from "../node/source";
import { captureModuleWorkspaceSource } from "../source";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("Module workspace source capture", () => {
  it("uses an injected filesystem namespace and always returns POSIX source paths", async () => {
    const files = new Map([
      ["C:\\workspace\\bun.lock", "lock"],
      ["C:\\workspace\\src\\index.ts", "authored"],
    ]);
    const source = await captureModuleWorkspaceSource(
      {
        readDirectory: (path) =>
          Promise.resolve(
            path === "C:\\workspace"
              ? [
                  { name: "bun.lock", type: "file" },
                  { name: "src", type: "directory" },
                ]
              : [{ name: "index.ts", type: "file" }]
          ),
        readFile: (path) => {
          const text = files.get(path);
          if (text === undefined) {
            return Promise.reject(new Error(`Unexpected read ${path}`));
          }
          return Promise.resolve(new TextEncoder().encode(text));
        },
        separator: "\\",
      },
      "C:\\workspace"
    );
    expect(source).toEqual({ "bun.lock": "lock", "src/index.ts": "authored" });
  });

  it("captures Node source and lockfiles, excludes secrets and generated data, and keeps the authored SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "module-source-"));
    directories.push(root);
    const files = {
      ".aws/token": "credentials",
      ".env": "secret",
      ".npmrc": "token",
      "bun.lock": "lock",
      "data.sqlite-wal": "database",
      "node_modules/pkg/index.js": "dependency",
      "packages/app/dist/index.js": "output",
      "packages/module-sdk/dist/index.js": "sdk",
      "packages/server/generated/schema.ts": "generated",
      "src/index.ts": "source",
    };
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    expect(await captureNodeSource(root)).toEqual({
      "bun.lock": "lock",
      "packages/module-sdk/dist/index.js": "sdk",
      "src/index.ts": "source",
    });
    await symlink(join(root, "src/index.ts"), join(root, "link.ts"));
    await expect(captureNodeSource(root)).rejects.toThrow(
      "unsupported symlink"
    );
    await rm(join(root, "link.ts"));
    await writeFile(join(root, "src/index.ts"), new Uint8Array([0xff]));
    await expect(captureNodeSource(root)).rejects.toThrow();
  });
});
