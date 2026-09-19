import { expect, it } from "vitest";

import { globToRegExp } from "../glob";

it.each([
  ["**/{CLAUDE,AGENTS}.md", "CLAUDE.md", true],
  ["**/{CLAUDE,AGENTS}.md", "packages/ui/AGENTS.md", true],
  ["**/{CLAUDE,AGENTS}.md", "packages/ui/README.md", false],
  ["*.md", "README.md", true],
  ["*.md", "docs/README.md", false],
  ["docs/**", "docs/a/b.txt", true],
  ["src/**/index.ts", "src/index.ts", true],
  ["src/**/index.ts", "src/a/b/index.ts", true],
  ["file?.ts", "file1.ts", true],
  ["file?.ts", "file12.ts", false],
  ["file?.ts", "file/.ts", false],
  ["*.{js,{ts,tsx}}", "app.tsx", true],
  ["*.{js,{ts,tsx}}", "app.css", false],
  ["{literal}", "{literal}", true],
  ["{literal}", "literal", false],
  ["a{b", "a{b", true],
  ["a}b", "a}b", true],
  ["a,b", "a,b", true],
  ["a[0]+(b).ts", "a[0]+(b).ts", true],
  ["a[0]+(b).ts", "a0b.ts", false],
  ["*.md", "README.md.bak", false],
  ["", "", true],
])("matches %j against %j: %s", (pattern, path, matches) => {
  expect(globToRegExp(pattern).test(path)).toBe(matches);
});
