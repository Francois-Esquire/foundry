import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cruiseWorkspace } from "../../src/lib/dependencies";
import type { FileMapCruiseInput } from "../../src/lib/file-map-cruise";
import { cruiseFileMap } from "../../src/lib/file-map-cruise";
import type { CruisedModule } from "../../src/lib/module-graph";
import { fileMapDisk } from "./helpers/file-map";

const ENGINE = resolve(
  import.meta.dirname,
  "../../dist/engine/file-map-cruise-engine.js"
);
const NODE_SPECIFIER = /(?:from\s*|import\(|require\()["']node:/;
const BARE_IMPORT = /^import\s.*?from\s*["']([^"'./][^"']*)["']/gm;

const LOCATION = /^.*?(error TS\d+)/s;
const disk = fileMapDisk("spyglass-cruise-native-");
const ROOT = "/spyglass-file-map";

afterAll(() => {
  disk.cleanup();
});

const files = {
  "package.json": JSON.stringify({
    name: "forms",
    workspaces: ["packages/*"],
  }),
  "packages/app/package.json": JSON.stringify({
    exports: { ".": "./src/index.ts" },
    name: "@f/app",
  }),
  "packages/app/src/helper.ts": "export const helper = 1;\n",
  "packages/app/src/index.ts": [
    'import "./side";',
    'import type { Shared } from "@f/shared";',
    'import fs from "node:fs";',
    'import legacy = require("./legacy");',
    'export { helper } from "./helper.js";',
    'const lazy = () => import("./lazy");',
    'type Tool = typeof import("~shared/tool");',
    'const missing = require("does-not-exist");',
    "export const all = [fs, legacy, lazy, missing] as unknown as Shared[] & Tool[];",
    "",
  ].join("\n"),
  "packages/app/src/lazy.ts": "export const lazy = 1;\n",
  "packages/app/src/legacy.ts": "export = 1;\n",
  "packages/app/src/side.ts": "export {};\n",
  "packages/app/src/unimported.js":
    'module.exports = require("./index");\nimport("./lazy");\n',
  "packages/app/vitest.config.ts": "export default {};\n",
  "packages/shared/package.json": JSON.stringify({
    exports: { ".": "./src/index.ts" },
    name: "@f/shared",
  }),
  "packages/shared/src/index.ts": "export type Shared = 1;\n",
  "packages/shared/src/tool.ts": "export const tool = 1;\n",
  "packages/shared/src/via.cjs": 'module.exports = require("./via.mjs");\n',
  "packages/shared/src/via.mjs": 'export * from "./index.ts";\n',
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: { "~shared/*": ["packages/shared/src/*"] },
    },
  }),
};
const layout = {
  aliases: { "@f/shared": ["packages/shared/src/index.ts"] },
  entries: ["packages/app", "packages/shared"],
};

function single(
  map: Readonly<Record<string, string>>,
  tsconfig?: string
): FileMapCruiseInput {
  return {
    aliases: {},
    entries: ["."],
    files: new Map(Object.entries({ "package.json": "{}", ...map })),
    root: ROOT,
    tsconfig,
  };
}

function hostSecrets(): string {
  const outside = disk.materialize({
    "base.json": JSON.stringify({
      compilerOptions: { paths: { "host/*": ["./*"] } },
    }),
    "nested.ts": "export const nested = 1;\n",
    "node_modules/host-package/index.js": "module.exports = 1;\n",
    "node_modules/host-package/package.json": '{"name":"host-package"}',
    "secret.ts": 'import "./nested";\nexport const secret = 42;\n',
  });
  return outside;
}

const sources = (graph: readonly { source: string }[]) =>
  graph.map((mod) => mod.source);

describe("the isolated file-map cruise engine", () => {
  it("bundles dependency-cruiser and memfs, importing only TypeScript", () => {
    const text = readFileSync(ENGINE, "utf8");
    expect(text).not.toMatch(NODE_SPECIFIER);
    expect(new Set([...text.matchAll(BARE_IMPORT)].map((m) => m[1]))).toEqual(
      new Set(["typescript"])
    );
  });

  it("leaves the host process and Buffer untouched once loaded", async () => {
    const hostProcess = globalThis.process;
    const hostBuffer = globalThis.Buffer;
    await cruiseFileMap(single({ "index.ts": "export const a = 1;\n" }));
    expect(globalThis.process).toBe(hostProcess);
    expect(globalThis.Buffer).toBe(hostBuffer);
  });

  it.each([
    ["the synthesized workspace aliases", undefined],
    ["an explicit tsconfig", "tsconfig.json"],
  ])("equals the native cruise under %s", async (_label, tsconfig) => {
    const native = await cruiseWorkspace(disk.materialize(files), tsconfig);
    const graph = await cruiseFileMap({
      ...layout,
      files: new Map(Object.entries(files)),
      root: ROOT,
      tsconfig,
    });
    expect(graph).toEqual(native);
    expect(sources(graph)).toEqual(
      expect.arrayContaining([
        "packages/app/src/unimported.js",
        "packages/shared/src/via.cjs",
      ])
    );
  });
});

describe("a file-map cruise reads only the map", () => {
  it("leaves absolute and escaping relative imports of host files unresolved", async () => {
    const outside = hostSecrets();
    const escaping = `${"../".repeat(12)}${outside.slice(1)}/secret`;
    const graph = await cruiseFileMap(
      single({
        "index.ts": `export { secret } from "${outside}/secret";\nexport { secret as again } from "${escaping}";\n`,
      })
    );
    expect(sources(graph).some((source) => source.includes("secret"))).toBe(
      true
    );
    for (const mod of graph) {
      expect(mod.source).not.toContain("nested");
      for (const dependency of mod.dependencies) {
        expect(dependency.couldNotResolve).toBe(true);
      }
    }
  });

  it("resolves no package, alias target or extends on the host", async () => {
    const outside = hostSecrets();
    const graph = await cruiseFileMap(
      single(
        {
          "index.ts": 'import "host-package";\nimport "host/secret";\n',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { "host/*": [`${outside}/*`] },
            },
          }),
        },
        "tsconfig.json"
      )
    );
    const index = graph.find((mod) => mod.source === "index.ts");
    expect(index?.dependencies.map((d) => d.couldNotResolve)).toEqual([
      true,
      true,
    ]);
    await expect(
      cruiseFileMap(
        single(
          {
            "index.ts": "export {};\n",
            "tsconfig.json": JSON.stringify({
              extends: `${outside}/base.json`,
            }),
          },
          "tsconfig.json"
        )
      )
    ).rejects.toThrow("TS5083");
  });

  it("isolates ten concurrent cruises from each other", async () => {
    const input = (n: number) =>
      single({
        [`a${n}.ts`]: `export const a = ${n};\n`,
        "index.ts": `export { a } from "./a${n}";\nexport * from "${ROOT}/a${(n + 1) % 10}";\n`,
      });
    const serial: CruisedModule[][] = [];
    for (let n = 0; n < 10; n += 1) {
      serial.push(await cruiseFileMap(input(n)));
    }
    const together = await Promise.all(
      Array.from({ length: 10 }, (_, n) => cruiseFileMap(input(n)))
    );
    expect(together).toEqual(serial);
    for (const [n, graph] of together.entries()) {
      expect(sources(graph).sort()).toEqual(
        [`a${n}.ts`, "index.ts", `${ROOT}/a${(n + 1) % 10}`].sort()
      );
    }
  });

  it("clears the volume after a failure and after a success", async () => {
    const settled = await Promise.allSettled([
      cruiseFileMap(single({ "left.ts": "export {};\n" }, "missing.json")),
      cruiseFileMap(single({ "kept.ts": "export {};\n" })),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    const graph = await cruiseFileMap(
      single({
        "index.ts": 'import "./left";\nimport "./kept";\n',
      })
    );
    const index = graph.find((mod) => mod.source === "index.ts");
    expect(index?.dependencies.map((d) => d.couldNotResolve)).toEqual([
      true,
      true,
    ]);
  });

  it("never runs a configuration, plugin or script in the map", async () => {
    const marker = join(disk.materialize({}), "EXECUTED");
    const poison = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\nthrow new Error("executed");\n`;
    const graph = await cruiseFileMap(
      single({
        ".dependency-cruiser.cjs": poison,
        "babel.config.js": poison,
        "index.ts": "export const x = 1;\n",
        "package.json": JSON.stringify({
          scripts: {
            postinstall: `touch ${marker}`,
            prepare: `touch ${marker}`,
          },
        }),
        "webpack.config.js": poison,
      })
    );
    expect(existsSync(marker)).toBe(false);
    expect(sources(graph)).toContain("index.ts");
  });
});

describe("an explicit tsconfig is refused as natively", () => {
  const normalized = (message: string, root: string) =>
    message.replaceAll(root, "<root>").replace(LOCATION, "$1");

  it.each([
    ["an extends it cannot read", { extends: "./missing.json" }, "TS5083"],
    [
      "an invalid moduleResolution",
      { compilerOptions: { moduleResolution: "INVALID" } },
      "TS6046",
    ],
    [
      "nothing for a moduleResolution native accepts",
      { compilerOptions: { moduleResolution: "node10" } },
      "accepted",
    ],
  ])("refuses %s as the native cruise does", async (_label, config, code) => {
    const map = {
      "index.ts": "export {};\n",
      "package.json": "{}",
      "tsconfig.json": JSON.stringify(config),
    };
    const nativeRoot = disk.materialize(map);
    const native = await cruiseWorkspace(nativeRoot, "tsconfig.json").then(
      () => "accepted",
      (error: unknown) => normalized(String(error), nativeRoot)
    );
    const mapped = await cruiseFileMap(single(map, "tsconfig.json")).then(
      () => "accepted",
      (error: unknown) => normalized(String(error), ROOT)
    );
    expect(native).toContain(code);
    expect(mapped).toBe(native);
  });

  it("accepts a tsconfig whose includes match only map files", async () => {
    const graph = await cruiseFileMap(
      single(
        {
          "src/index.ts": "export {};\n",
          "tsconfig.json": JSON.stringify({ include: ["src"] }),
        },
        "tsconfig.json"
      )
    );
    expect(sources(graph)).toContain("src/index.ts");
  });
});

describe("the engine source outside its bundle", () => {
  it("refuses to cruise against the real file system", async () => {
    const engine = await import("../../src/lib/file-map-cruise-engine");
    await expect(
      engine.cruiseFileMap(single({ "index.ts": "export {};\n" }))
    ).rejects.toThrow("isolated engine bundle");
  });
});
