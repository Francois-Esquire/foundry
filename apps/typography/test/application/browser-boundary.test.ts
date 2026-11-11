/**
 * Nothing the browser loads may reach the Node composition. This follows
 * every import from the app's entry point and checks none of them is a
 * module that needs Node.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reach, relative, SRC } from "./helpers/imports";

/** Modules that need Node, and the packages only they may import. */
const NODE_ONLY = [
  "src/application/node.ts",
  "src/generation/node-image-codec.ts",
  "src/packaging/engine/node.ts",
];
const NODE_PACKAGES = ["@foundry/artifacts/node", "fast-png", "jpeg-js"];

describe("what the browser loads", () => {
  it("never reaches a module that needs Node", () => {
    const { files, packages } = reach(path.join(SRC, "main.tsx"));
    expect(files.size).toBeGreaterThan(200);
    // The screens run on the application interface, so the walk goes through it.
    expect(relative(files)).toEqual(
      expect.arrayContaining([
        "src/application/application.ts",
        "src/application/places.ts",
        "src/application/react.tsx",
      ])
    );
    expect(packages.has("@foundry/artifacts")).toBe(true);
    expect(relative(files).filter((file) => NODE_ONLY.includes(file))).toEqual(
      []
    );
    expect(NODE_PACKAGES.filter((name) => packages.has(name))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
  });

  it("can take the application interface without the Node composition", () => {
    const { files, packages } = reach(
      path.join(SRC, "application/application.ts")
    );
    expect(relative(files).filter((file) => NODE_ONLY.includes(file))).toEqual(
      []
    );
    expect(NODE_PACKAGES.filter((name) => packages.has(name))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
    expect(packages.has("@foundry/artifacts")).toBe(true);
  });

  it("is checked by a walk that does see the Node modules", () => {
    const { files, packages } = reach(path.join(SRC, "application/node.ts"));
    expect(relative(files)).toEqual(expect.arrayContaining(NODE_ONLY));
    expect(packages.has("@foundry/artifacts/node")).toBe(true);
  });
});
