import { Project, ts } from "ts-morph";
import { expect, it } from "vitest";
import { importSpecifierFor } from "../../src/lib/import-specifier";

/** An in-memory project of `files`, by absolute path, resolved as a bundler would. */
function projectOf(files: Record<string, string>): Project {
  const project = new Project({
    compilerOptions: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    useInMemoryFileSystem: true,
  });
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(path, text);
  }
  return project;
}

/** The specifier `/src/user.ts` would write for `target`, given its imports. */
function specifierFor(
  imports: string,
  target = "/src/model.ts",
  hint?: string
): string {
  const project = projectOf({
    "/src/a.ts": "export const a = 1;\n",
    "/src/b.ts": "export const b = 1;\n",
    "/src/c.ts": "export const c = 1;\n",
    "/src/deep/index.ts": "export const deep = 1;\n",
    "/src/model.ts": "export const model = 1;\n",
    "/src/module.mts": "export const mts = 1;\n",
    "/src/user.ts": imports,
    "/src/view.tsx": "export const view = 1;\n",
  });
  const importer = project.getSourceFileOrThrow("/src/user.ts");
  return importSpecifierFor(
    importer,
    project.getSourceFileOrThrow(target),
    hint
  );
}

it("reuses the importer's own specifier for the module, however it is spelled", () => {
  expect(
    specifierFor(
      'import { a } from "./a.js";\nimport { model } from "./model.ts";\n'
    )
  ).toBe("./model.ts");
  expect(specifierFor('export { model } from "./model";\n')).toBe("./model");
  expect(specifierFor('import type { model } from "./model.ts";\n')).toBe(
    "./model.ts"
  );
  expect(specifierFor('import * as m from "./model.js";\n')).toBe("./model.js");
});

it("follows the importer's relative style by majority", () => {
  expect(
    specifierFor(
      'import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { c } from "./c";\n'
    )
  ).toBe("./model.js");
  expect(
    specifierFor(
      'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { c } from "./c.js";\n'
    )
  ).toBe("./model.ts");
  expect(
    specifierFor('import { a } from "./a";\nimport { b } from "./b.js";\n')
  ).toBe("./model");
  expect(
    specifierFor('import { a } from "./a.ts";\nimport { b } from "./b.js";\n')
  ).toBe("./model.js");
});

it("maps the source extension to its JavaScript one, and keeps it in the .ts style", () => {
  const js = 'import { a } from "./a.js";\n';
  expect(specifierFor(js, "/src/view.tsx")).toBe("./view.js");
  expect(specifierFor(js, "/src/module.mts")).toBe("./module.mjs");
  expect(specifierFor('import { a } from "./a.ts";\n', "/src/view.tsx")).toBe(
    "./view.tsx"
  );
  expect(specifierFor('import { a } from "./a";\n', "/src/module.mts")).toBe(
    "./module.mjs"
  );
});

it("falls back to the hint's style, then to extensionless, ignoring package specifiers", () => {
  const packaged = 'import { x } from "@t/a";\n';
  expect(specifierFor(packaged, "/src/model.ts", "./other.js")).toBe(
    "./model.js"
  );
  expect(specifierFor(packaged, "/src/model.ts", "@t/a/sub")).toBe("./model");
  expect(specifierFor(packaged)).toBe("./model");
});

it("never collapses /index and climbs out of the importer's directory", () => {
  expect(specifierFor("", "/src/deep/index.ts")).toBe("./deep/index");
  const project = projectOf({
    "/src/model.ts": "export const model = 1;\n",
    "/src/nested/user.ts": 'import { x } from "../x.js";\n',
  });
  expect(
    importSpecifierFor(
      project.getSourceFileOrThrow("/src/nested/user.ts"),
      project.getSourceFileOrThrow("/src/model.ts")
    )
  ).toBe("../model.js");
});
