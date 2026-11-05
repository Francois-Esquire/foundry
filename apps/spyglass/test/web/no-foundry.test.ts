import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";

const WEB = join(import.meta.dirname, "../../src/web");
const FOUNDRY = /foundry/i;
/** An import of a package the viewer depends on, such as the shared ordering helpers: code, not a name a reader sees. */
const DEPENDENCY_IMPORT = /from "@foundry\/[^"]+"/g;

/**
 * The switch to the copied renderer re-exports its dataset adapter, whose
 * module and function are named for where they came from: that one line,
 * in that one file.
 */
const SWITCH = join(WEB, "islands-host", "islands-api.ts");
const ADAPTER_EXPORT =
  'export { chartFromFoundry as chartFromDataset } from "../islands/data/foundry";';

/** The renderer copied in from another repository, whose names are its own (`src/web/islands/README.md`). */
const COPIED = join(WEB, "islands");
const inCopy = (path: string) =>
  path === COPIED || path.startsWith(`${COPIED}${sep}`);

/** The viewer's own files; its design notes may name where it came from. */
function viewerFiles(): string[] {
  return readdirSync(WEB, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".md"))
    .filter((entry) => !inCopy(entry.parentPath))
    .map((entry) => join(entry.parentPath, entry.name));
}

it("names no Foundry package or caption, so any workspace reads as its own", () => {
  const naming = viewerFiles()
    .filter((file) => {
      const text = readFileSync(file, "utf8").replace(DEPENDENCY_IMPORT, "");
      return FOUNDRY.test(
        file === SWITCH ? text.replace(ADAPTER_EXPORT, "") : text
      );
    })
    .map((file) => relative(WEB, file));
  expect(naming).toEqual([]);
});
