import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";

const WEB = join(import.meta.dirname, "../../src/web");
const FOUNDRY = /foundry/i;
const DEPENDENCY_IMPORT = /from "@foundry\/[^"]+"/g;

const SWITCH = join(WEB, "islands-host", "islands-api.ts");
const ADAPTER_EXPORT = "  chartFromFoundry as chartFromDataset,";

const COPIED = join(WEB, "islands");
const inCopy = (path: string) =>
  path === COPIED || path.startsWith(`${COPIED}${sep}`);

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
