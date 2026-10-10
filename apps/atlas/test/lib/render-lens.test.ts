import { describe, expect, it } from "vitest";
import type { PackageSize } from "../../src/lib/lenses/package-sizes-types";
import { renderLens } from "../../src/lib/render";

const NO_FILES = {
  config: 0,
  other: 0,
  source: 0,
  story: 0,
  test: 0,
  unknown: 0,
};

function sized(id: string, layer: number | null, files: number): PackageSize {
  return {
    analyzed: layer !== null,
    id,
    layer,
    modules: { byKind: { ...NO_FILES, source: files }, total: files },
  };
}

describe("renderLens", () => {
  it("prints the package-sizes lens as text, largest package first", () => {
    const text = renderLens(
      "package-sizes",
      {
        packages: [
          sized("@s/a", 1, 2),
          sized("@s/b", 0, 3),
          sized("@s/c", null, 0),
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Package sizes",
        "═════════════",
        "Packages  3 (2 analyzed)",
        "Layers    2",
        "Files     5",
        "",
        "Files by package",
        "  @s/b  3",
        "    layer 0",
        "  @s/a  2",
        "    layer 1",
        "  @s/c  0",
        "    no layer",
      ].join("\n")
    );
  });

  it("lists five packages at compact density and counts the rest", () => {
    const packages = ["a", "b", "c", "d", "e", "f", "g"].map((name, index) =>
      sized(`@s/${name}`, 0, 10 - index)
    );
    const text = renderLens(
      "package-sizes",
      { packages },
      { density: "compact", format: "text" }
    );
    expect(text).toContain("@s/e   6");
    expect(text).not.toContain("@s/f");
    expect(text).toContain("2 more");
  });

  it("prints the file-roles lens: files by role, high fan-in by fan-in, and packages saved without internals", () => {
    const text = renderLens(
      "file-roles",
      {
        missing: ["@s/c"],
        packages: [
          {
            highFanInCutoff: 3,
            id: "@s/a",
            modules: [
              {
                fanIn: 4,
                highFanIn: true,
                module: "a/hub.ts",
                role: "junction",
              },
              { fanIn: 9, highFanIn: true, module: "a/types.ts" },
              { fanIn: 1, highFanIn: false, module: "a/x.ts", role: "mixed" },
            ],
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "File roles",
        "══════════",
        "Packages               1",
        "Files                  3",
        "Composition junctions  1",
        "Mixed scope            1",
        "Shared commons         0",
        "Unknown scope          0",
        "",
        "High fan-in",
        "  a/types.ts  9",
        "    @s/a · cutoff 3",
        "  a/hub.ts    4",
        "    @s/a · cutoff 3",
        "",
        "Saved without internals",
        "  @s/c",
      ].join("\n")
    );
  });

  it("leaves out the high fan-in list when no package has a high fan-in file", () => {
    const text = renderLens(
      "file-roles",
      {
        missing: [],
        packages: [
          {
            highFanInCutoff: 0,
            id: "@s/a",
            modules: [{ fanIn: 0, highFanIn: false, module: "a/x.ts" }],
          },
        ],
      },
      { format: "text" }
    );
    expect(text).not.toContain("High fan-in");
    expect(text).not.toContain("Saved without internals");
  });
});
