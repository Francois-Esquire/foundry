import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CollectionManifestWorkspace } from "../../src/lib/collection-manifest";
import {
  collectionManifest,
  qualifiedId,
} from "../../src/lib/collection-manifest";
import type { CollectionManifest } from "../../src/lib/collection-types";
import { COLLECTION_SCHEMA_VERSION } from "../../src/lib/collection-types";
import { scan } from "../../src/lib/scan";
import type {
  SemanticsDeclaredDependencies,
  SemanticsManifestPackage,
  SemanticsSkippedDirectory,
} from "../../src/lib/semantics-types";
import { resolveCollection } from "../../src/lib/state";

const SCAN_TIMEOUT_MS = 120_000;

/** A manifest's package entry with only what the collection manifest reads. */
function pkg(
  id: string,
  declaredDependencies: SemanticsDeclaredDependencies = {}
): SemanticsManifestPackage {
  return {
    declaredDependencies,
    id,
    modules: { count: 0 },
    path: id,
    status: "complete",
  };
}

/** One workspace of literal manifests, rooted under `/repos`. */
function workspace(
  id: string,
  packages: SemanticsManifestPackage[],
  {
    name,
    root = `/repos/${id}`,
    skipped = [],
  }: {
    name?: string;
    root?: string;
    skipped?: SemanticsSkippedDirectory[];
  } = {}
): CollectionManifestWorkspace {
  return {
    id,
    manifest: {
      discovery: { unitsSkipped: skipped },
      generatedAt: `2026-10-10T00:00:0${id.length}.000Z`,
      packages,
      workspace: { root, ...(name !== undefined && { name }) },
    },
    root,
  };
}

it("crosses a dependency to the one other workspace that holds its name", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: { "@k/db": "^1.0.0" },
        peerDependencies: { "@k/db": ">=1" },
      }),
    ]),
  ]);
  expect(manifest.crossings).toEqual([
    {
      from: "bbb:@p/app",
      kind: "dependencies",
      range: "^1.0.0",
      to: "aaa:@k/db",
    },
    {
      from: "bbb:@p/app",
      kind: "peerDependencies",
      range: ">=1",
      to: "aaa:@k/db",
    },
  ]);
  expect(manifest.ambiguous).toEqual([]);
  expect(manifest.schemaVersion).toBe(COLLECTION_SCHEMA_VERSION);
});

it("keeps a dependency its own workspace holds inside it, even when another holds the name too", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/shared")]),
    workspace("bbb", [
      pkg("@k/shared"),
      pkg("@p/app", { dependencies: { "@k/shared": "^1.0.0" } }),
      pkg("@p/self", { devDependencies: { "@p/self": "*" } }),
    ]),
  ]);
  expect(manifest.crossings).toEqual([]);
  expect(manifest.ambiguous).toEqual([]);
});

it("never crosses a workspace: range, whatever the other workspaces hold", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: { "@k/db": "workspace:*" },
        devDependencies: { alias: "workspace:@k/db@*" },
      }),
    ]),
  ]);
  expect(manifest.crossings).toEqual([]);
});

it("resolves an npm: alias to the package it names, and records the range as written", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db"), pkg("lodash")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: {
          "@k/db": "npm:left-pad@1",
          broken: "npm:",
          database: "npm:@k/db@^1.0.0",
          scoped: "npm:@k/db",
          utilities: "npm:lodash",
        },
      }),
    ]),
  ]);
  // `@k/db` is aliased to left-pad, which no workspace holds, and a bare
  // `npm:` names no package, so neither crosses.
  expect(manifest.crossings).toEqual([
    {
      from: "bbb:@p/app",
      kind: "dependencies",
      range: "npm:@k/db",
      to: "aaa:@k/db",
    },
    {
      from: "bbb:@p/app",
      kind: "dependencies",
      range: "npm:@k/db@^1.0.0",
      to: "aaa:@k/db",
    },
    {
      from: "bbb:@p/app",
      kind: "dependencies",
      range: "npm:lodash",
      to: "aaa:lodash",
    },
  ]);
});

it("records the range without checking it against the package found", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")]),
    workspace("bbb", [
      pkg("@p/app", { optionalDependencies: { "@k/db": "^99.0.0" } }),
    ]),
  ]);
  expect(manifest.crossings).toEqual([
    {
      from: "bbb:@p/app",
      kind: "optionalDependencies",
      range: "^99.0.0",
      to: "aaa:@k/db",
    },
  ]);
});

it("records a name two other workspaces hold as ambiguous, with no crossing", () => {
  const manifest = collectionManifest([
    workspace("ccc", [pkg("@k/shared")]),
    workspace("aaa", [pkg("@k/shared")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: { "@k/shared": "^1.0.0" },
        devDependencies: { shared: "npm:@k/shared@2" },
      }),
    ]),
  ]);
  expect(manifest.crossings).toEqual([]);
  expect(manifest.ambiguous).toEqual([
    {
      candidates: ["aaa:@k/shared", "ccc:@k/shared"],
      from: "bbb:@p/app",
      kind: "dependencies",
      name: "@k/shared",
      range: "^1.0.0",
    },
    {
      candidates: ["aaa:@k/shared", "ccc:@k/shared"],
      from: "bbb:@p/app",
      kind: "devDependencies",
      name: "@k/shared",
      range: "npm:@k/shared@2",
    },
  ]);
});

it("records nothing for a name no workspace of the collection holds", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")]),
    workspace("bbb", [pkg("@p/app", { dependencies: { react: "^19.0.0" } })]),
  ]);
  expect(manifest).toMatchObject({ ambiguous: [], crossings: [] });
});

it("lists each workspace by root, with its dataset, pin, and qualified packages, failed ones too", () => {
  const second = workspace(
    "bbb",
    [pkg("@p/web"), { ...pkg("@p/app"), error: "boom", status: "failed" }],
    { name: "product" }
  );
  const manifest = collectionManifest([
    second,
    workspace("aaa", [pkg("@k/db")]),
  ]);
  expect(manifest.workspaces).toEqual([
    {
      dataset: "aaa/",
      generatedAt: "2026-10-10T00:00:03.000Z",
      id: "aaa",
      label: "aaa",
      packages: ["aaa:@k/db"],
    },
    {
      dataset: "bbb/",
      generatedAt: second.manifest.generatedAt,
      id: "bbb",
      label: "product",
      packages: ["bbb:@p/app", "bbb:@p/web"],
    },
  ]);
});

it("crosses to a package that failed analysis, since its workspace still holds it", () => {
  const manifest = collectionManifest([
    workspace("aaa", [{ ...pkg("@k/db"), status: "failed" }]),
    workspace("bbb", [pkg("@p/app", { dependencies: { "@k/db": "^1.0.0" } })]),
  ]);
  expect(manifest.crossings.map((crossing) => crossing.to)).toEqual([
    "aaa:@k/db",
  ]);
});

const SKIPPED_CFG: SemanticsSkippedDirectory[] = [
  { name: "@x/cfg", path: "packages/cfg", reason: "analysis unsupported" },
];

it("keeps a dependency on a package its own scan skipped inside its workspace", () => {
  const javascript = workspace(
    "aaa",
    [pkg("@a/app", { dependencies: { "@x/cfg": "^1.0.0" } })],
    { skipped: SKIPPED_CFG }
  );
  const typescript = workspace("bbb", [pkg("@x/cfg")]);
  expect(collectionManifest([javascript, typescript])).toMatchObject({
    ambiguous: [],
    crossings: [],
  });
});

it("never crosses to a package another workspace only skipped", () => {
  const manifest = collectionManifest([
    workspace("aaa", [], { skipped: SKIPPED_CFG }),
    workspace("ccc", [
      pkg("@c/app", { devDependencies: { "@x/cfg": "^1.0.0" } }),
    ]),
  ]);
  expect(manifest).toMatchObject({ ambiguous: [], crossings: [] });
});

it("counts a skipped package toward ambiguity, but names only analyzed ones as candidates", () => {
  const manifest = collectionManifest([
    workspace("aaa", [], { skipped: SKIPPED_CFG }),
    workspace("bbb", [pkg("@x/cfg")]),
    workspace("ccc", [
      pkg("@c/app", { devDependencies: { "@x/cfg": "^1.0.0" } }),
    ]),
    workspace("ddd", [], { skipped: SKIPPED_CFG }),
    workspace("eee", [pkg("@e/app", { dependencies: { "@x/cfg": "1" } })]),
  ]);
  expect(manifest.crossings).toEqual([]);
  expect(manifest.ambiguous).toEqual([
    {
      candidates: ["bbb:@x/cfg"],
      from: "ccc:@c/app",
      kind: "devDependencies",
      name: "@x/cfg",
      range: "^1.0.0",
      skippedIn: ["aaa", "ddd"],
    },
    {
      candidates: ["bbb:@x/cfg"],
      from: "eee:@e/app",
      kind: "dependencies",
      name: "@x/cfg",
      range: "1",
      skippedIn: ["aaa", "ddd"],
    },
  ]);
  const onlySkipped = collectionManifest([
    workspace("aaa", [], { skipped: SKIPPED_CFG }),
    workspace("ccc", [pkg("@c/app", { dependencies: { "@x/cfg": "1" } })]),
    workspace("ddd", [], { skipped: SKIPPED_CFG }),
  ]);
  expect(onlySkipped.ambiguous).toMatchObject([
    { candidates: [], skippedIn: ["aaa", "ddd"] },
  ]);
});

/** Every crossing's ends and every candidate that no workspace lists among its packages. */
function unlisted(manifest: CollectionManifest): string[] {
  const listed = new Set(
    manifest.workspaces.flatMap((entry) => entry.packages)
  );
  return [
    ...manifest.crossings.flatMap(({ from, to }) => [from, to]),
    ...manifest.ambiguous.flatMap(({ candidates, from }) => [
      from,
      ...candidates,
    ]),
  ].filter((id) => !listed.has(id));
}

it("ends every crossing and names every candidate at a listed package", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")], { skipped: SKIPPED_CFG }),
    workspace("bbb", [pkg("@x/cfg"), pkg("@k/log")], {
      skipped: [
        { name: "@k/db", path: "dist", reason: "generated output" },
        { name: "@k/util", path: "packages/util", reason: "excluded" },
      ],
    }),
    workspace("ccc", [
      pkg("@c/app", {
        dependencies: {
          "@k/db": "^1.0.0",
          "@k/log": "^1.0.0",
          "@k/util": "^1.0.0",
          "@x/cfg": "^1.0.0",
        },
      }),
    ]),
  ]);
  expect(manifest.crossings.map(({ to }) => to)).toEqual(["bbb:@k/log"]);
  expect(manifest.ambiguous.map(({ name }) => name)).toEqual([
    "@k/db",
    "@x/cfg",
  ]);
  expect(unlisted(manifest)).toEqual([]);
});

it("labels workspaces that share a parent and a name by their id's first digits", () => {
  const manifest = collectionManifest([
    workspace("0123456789ab", [], { name: "foundry", root: "/a/code/foundry" }),
    workspace("fedcba987654", [], { name: "foundry", root: "/b/code/foundry" }),
  ]);
  expect(manifest.workspaces.map((entry) => entry.label)).toEqual([
    "code/foundry (012345)",
    "code/foundry (fedcba)",
  ]);
});

it("labels workspaces that share a name by their parent directory as well", () => {
  const manifest = collectionManifest([
    workspace("aaa", [], { name: "foundry", root: "/code/one/foundry" }),
    workspace("bbb", [], { name: "foundry", root: "/code/two/foundry" }),
    workspace("ccc", [], { root: "/code/agents" }),
  ]);
  expect(manifest.workspaces.map((entry) => entry.label)).toEqual([
    "agents",
    "one/foundry",
    "two/foundry",
  ]);
});

it("is the same whatever the order of workspaces, packages, and dependencies", () => {
  const forward = collectionManifest([
    workspace("aaa", [pkg("@k/db"), pkg("@k/log")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: { "@k/db": "^1.0.0", "@k/log": "^2.0.0" },
        devDependencies: { "@k/db": "^1.1.0" },
      }),
      pkg("@p/api", {
        dependencies: { "@k/log": "^2.0.0", alias: "npm:@k/db@1" },
      }),
    ]),
  ]);
  const backward = collectionManifest([
    workspace("bbb", [
      pkg("@p/api", {
        dependencies: { "@k/log": "^2.0.0", alias: "npm:@k/db@1" },
      }),
      pkg("@p/app", {
        dependencies: { "@k/db": "^1.0.0", "@k/log": "^2.0.0" },
        devDependencies: { "@k/db": "^1.1.0" },
      }),
    ]),
    workspace("aaa", [pkg("@k/log"), pkg("@k/db")]),
  ]);
  expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  expect(forward.crossings.map(({ from, to }) => `${from} ${to}`)).toEqual([
    "bbb:@p/api aaa:@k/db",
    "bbb:@p/api aaa:@k/log",
    "bbb:@p/app aaa:@k/db",
    "bbb:@p/app aaa:@k/db",
    "bbb:@p/app aaa:@k/log",
  ]);
  expect(qualifiedId("aaa", "@k/db")).toBe("aaa:@k/db");
});

it("breaks a tie on the range last", () => {
  const manifest = collectionManifest([
    workspace("aaa", [pkg("@k/db")]),
    workspace("bbb", [
      pkg("@p/app", {
        dependencies: { db1: "npm:@k/db@1", db2: "npm:@k/db@2" },
      }),
    ]),
  ]);
  expect(manifest.crossings.map((crossing) => crossing.range)).toEqual([
    "npm:@k/db@1",
    "npm:@k/db@2",
  ]);
});

let directory: string;

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-collection-")));
});

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

it(
  "crosses from the product fixture to the platform fixture, and keeps their shared name apart",
  async () => {
    const roots = ["platform", "product"].map((name) => {
      const target = join(directory, name);
      cpSync(
        join(import.meta.dirname, "fixtures", "collection", name),
        target,
        {
          recursive: true,
        }
      );
      return target;
    });
    const state = join(directory, "state");
    const collection = await resolveCollection(roots, state);
    const input = await Promise.all(
      collection.map(async ({ id, root }) => ({
        id,
        manifest: (await scan.workspace(root, { state })).manifest,
        root,
      }))
    );
    const [platform, product] = collection.map(({ id }) => id);
    const manifest = collectionManifest(input);
    expect(manifest.workspaces).toMatchObject([
      {
        label: "platform",
        packages: [`${platform}:@k/db`, `${platform}:@k/shared`],
      },
      {
        label: "product",
        packages: [
          `${product}:@k/shared`,
          `${product}:@p/app`,
          `${product}:@p/web`,
        ],
      },
    ]);
    expect(manifest.crossings).toEqual([
      {
        from: `${product}:@p/app`,
        kind: "dependencies",
        range: "^1.0.0",
        to: `${platform}:@k/db`,
      },
      {
        from: `${product}:@p/web`,
        kind: "dependencies",
        range: "npm:@k/db@^1.0.0",
        to: `${platform}:@k/db`,
      },
    ]);
    expect(manifest.ambiguous).toEqual([]);
    expect(unlisted(manifest)).toEqual([]);
  },
  SCAN_TIMEOUT_MS
);
