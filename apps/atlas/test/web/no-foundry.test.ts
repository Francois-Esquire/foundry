import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const WEB = join(import.meta.dirname, "../../src/web");
const FOUNDRY = /foundry/i;
/** An import of a package the viewer depends on, such as the shared ordering helpers: code, not a name a reader sees. */
const DEPENDENCY_IMPORT = /from "@foundry\/[^"]+"/g;

/** The viewer's own files; its design notes may name where it came from. */
function viewerFiles(): string[] {
  return readdirSync(WEB, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

it("names no Foundry package or caption, so any workspace reads as its own", () => {
  const naming = viewerFiles()
    .filter((file) =>
      FOUNDRY.test(readFileSync(file, "utf8").replace(DEPENDENCY_IMPORT, ""))
    )
    .map((file) => relative(WEB, file));
  expect(naming).toEqual([]);
});
