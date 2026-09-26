import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { roleOf } from "../../src/lib/module-roles";

function role(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return roleOf(project.createSourceFile("index.ts", source), false);
}

describe("module roles", () => {
  it("reads direct re-exports as an aggregator", () => {
    expect(
      role(`export { Foo } from "./foo";\nexport * from "./bar";`)
    ).toEqual({
      entrypoint: false,
      kind: "aggregator",
      ownDeclarations: 0,
      reExports: 2,
    });
  });

  it("reads import-then-export as an aggregator", () => {
    expect(
      role(
        `import { Foo } from "./foo";\nimport type { Bar } from "./bar";\nexport { Foo, Bar };`
      )
    ).toEqual({
      entrypoint: false,
      kind: "aggregator",
      ownDeclarations: 0,
      reExports: 1,
    });
  });

  it("does not count an export list of local declarations as forwarding", () => {
    expect(
      role(
        `import { Foo } from "./foo";\nconst local = Foo;\nexport { local };`
      )
    ).toEqual({
      entrypoint: false,
      kind: "internal",
      ownDeclarations: 1,
      reExports: 0,
    });
  });

  it("stays internal when declarations outnumber forwards", () => {
    expect(
      role(
        `import { Foo } from "./foo";\nexport { Foo };\nexport function a() {}\nexport function b() {}`
      ).kind
    ).toBe("internal");
  });
});
