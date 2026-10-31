import { expect, it } from "vitest";

import { globToRegExp } from "../glob";

const COMPILED_SOURCE = /^src\/(?:[^/]+\/)*[^/]*\.(?:ts|tsx)$/;

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

it("stays a RegExp with the equivalent source", () => {
  const glob = globToRegExp("src/**/*.{ts,tsx}");

  expect(glob).toBeInstanceOf(RegExp);
  expect(glob.source).toBe(COMPILED_SOURCE.source);
  expect(glob.exec("src/a/b.ts")).toEqual(
    Object.assign(["src/a/b.ts"], {
      groups: undefined,
      index: 0,
      input: "src/a/b.ts",
    })
  );
  expect(glob.exec("src/a/b.css")).toBeNull();
  expect("src/b.tsx".match(glob)?.index).toBe(0);
  expect("x".split(glob)).toEqual(["x"]);
});

it("refuses to be recompiled, so its source and matching cannot diverge", () => {
  const glob = globToRegExp("*.md");

  expect(() => glob.compile("x")).toThrow(TypeError);
  expect(glob.source).toBe("^[^/]*\\.md$");
  expect(glob.test("README.md")).toBe(true);
  expect(glob.test("x")).toBe(false);
});

/** A small deterministic generator, so a failing shape reproduces. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const PATTERN_PIECES = [
  "a",
  "b",
  ".",
  "/",
  "*",
  "**",
  "**/",
  "?",
  "{a,b}",
  "{a*,**/b}",
  "{x}",
  "{",
  "}",
  ",",
];
const PATH_PIECES = ["a", "b", ".", "/", "x", "{", "}", ",", "\n"];

it("matches exactly what the equivalent backtracking regex matches", () => {
  const next = sequence(7);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)] as T;
  for (let round = 0; round < 3000; round += 1) {
    const pattern = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
      pick(PATTERN_PIECES)
    ).join("");
    const glob = globToRegExp(pattern);
    const reference = new RegExp(glob.source);
    for (let probe = 0; probe < 8; probe += 1) {
      const path = Array.from({ length: Math.floor(next() * 8) }, () =>
        pick(PATH_PIECES)
      ).join("");
      expect([pattern, path, glob.test(path)]).toEqual([
        pattern,
        path,
        reference.test(path),
      ]);
    }
  }
});

it("reads a path one UTF-16 code unit at a time, as the regex does", () => {
  for (const [pattern, path] of [
    ["file?.ts", "file\u{1F600}.ts"],
    ["file??.ts", "file\u{1F600}.ts"],
    ["*.ts", "\u{1F600}.ts"],
    ["**", "a\nb"],
    ["**/*.ts", "a\u2028b/c.ts"],
    ["*", "a\rb"],
  ] as const) {
    const glob = globToRegExp(pattern);
    expect(glob.test(path)).toBe(new RegExp(glob.source).test(path));
  }
});

it("keeps matching linear when wildcards overlap", () => {
  const path = Array.from({ length: 16 }, () => "a".repeat(255)).join("/");
  const started = performance.now();

  expect(globToRegExp("**a**a**a**a**b").test(path)).toBe(false);
  expect(globToRegExp("*a*a*a*a*a*a*b").test("a".repeat(255))).toBe(false);
  // A backtracking match of these takes minutes; this is milliseconds.
  expect(performance.now() - started).toBeLessThan(1000);
});

it("matches a brace with more alternatives than one call takes arguments", () => {
  const glob = globToRegExp(`a{${",".repeat(200_000)}}b`);
  expect(glob.test("ab")).toBe(true);
  expect(glob.test("axb")).toBe(false);
});
