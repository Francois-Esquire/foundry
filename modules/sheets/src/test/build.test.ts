import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

it("builds a production release from a path containing spaces and non-ASCII characters", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "Sheets build é "));
  try {
    await cp(join(root, "src"), join(directory, "src"), { recursive: true });
    for (const name of [
      "package.json",
      "foundry.module.json",
      "tsconfig.json",
    ]) {
      await cp(join(root, name), join(directory, name));
    }
    await symlink(
      join(root, "../../node_modules"),
      join(directory, "node_modules"),
      "dir"
    );
    const env = { ...process.env };
    env.NODE_ENV = undefined;
    env.BUN_ENV = undefined;
    await run("bun", ["src/build.ts"], { cwd: directory, env });
    const release = JSON.parse(
      await readFile(join(directory, "dist/sheets.module.json"), "utf8")
    ) as { content: { blobs: Record<string, string> } };
    const scripts = Object.values(release.content.blobs)
      .map((blob) => Buffer.from(blob, "base64").toString("utf8"))
      .join("\n");
    expect(scripts).not.toContain("react-dom-client.development.js");
    expect(scripts).not.toContain("react.development.js");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
