import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import {
  analyzeInternalPackageTopology,
  getModuleNeighborhood,
} from "../../src/lib/internal-topology";
import type { InternalPackageTopology } from "../../src/lib/internal-topology-types";
import { INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION } from "../../src/lib/internal-topology-types";
import { analyzePackageLocal } from "../../src/lib/package-local";

// V13.0 internal topology on synthetic packages. Each fixture is one package
// in a throwaway workspace; the topology must be a pure function of that
// package's own files, so the independence tests perturb everything else.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

/** A workspace holding `packages/p` (name `@f/p`) with the given package-relative files. */
function workspace(
  files: Record<string, string>,
  extra: Record<string, string> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-topology-"));
  const root = fs.realpathSync(dir);
  tempRoots.push(root);
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "root", workspaces: ["packages/*"] })
  );
  write(
    "packages/p/package.json",
    JSON.stringify({ exports: { ".": "./src/index.ts" }, name: "@f/p" })
  );
  for (const [file, text] of Object.entries(files)) {
    write(path.join("packages/p", file), text);
  }
  for (const [file, text] of Object.entries(extra)) {
    write(file, text);
  }
  return root;
}

function topologyOf(
  files: Record<string, string>,
  extra?: Record<string, string>
): InternalPackageTopology {
  const root = workspace(files, extra);
  return analyzeInternalPackageTopology(
    analyzePackageLocal({ root, target: "packages/p" })
  );
}

function module(topology: InternalPackageTopology, id: string) {
  const found = topology.modules.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`module not found: ${id}`);
  }
  return found;
}

function rolesOf(topology: InternalPackageTopology, id: string): string[] {
  return (
    topology.roles.find((assignment) => assignment.module === id)?.roles ?? []
  );
}

const chain = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
  "src/b.ts": 'import { c } from "./c";\nexport const b = c + 1;\n',
  "src/c.ts": "export const c = 1;\n",
};

describe("simple chain a → b → c", () => {
  const topology = topologyOf(chain);

  it("has three modules, two edges, no cycle", () => {
    expect(topology.schemaVersion).toBe(
      INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION
    );
    expect(topology.package).toEqual({ id: "@f/p", root: "packages/p" });
    expect(topology.summary.modules).toBe(3);
    expect(topology.summary.primaryEdges).toBe(2);
    expect(topology.cycles).toEqual([]);
    expect(topology.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
    ]);
  });

  it("counts fan-in and fan-out per module", () => {
    expect(module(topology, "src/a.ts")).toMatchObject({ fanIn: 0, fanOut: 1 });
    expect(module(topology, "src/b.ts")).toMatchObject({ fanIn: 1, fanOut: 1 });
    expect(module(topology, "src/c.ts")).toMatchObject({ fanIn: 1, fanOut: 0 });
  });

  it("layers by longest dependency chain to a sink", () => {
    expect(topology.layers).toEqual([
      { index: 0, modules: ["src/c.ts"] },
      { index: 1, modules: ["src/b.ts"] },
      { index: 2, modules: ["src/a.ts"] },
    ]);
  });

  it("names sources, sinks, the articulation module, and single-neighbor satellites", () => {
    expect(rolesOf(topology, "src/a.ts")).toEqual([
      "dependency-source",
      "satellite",
    ]);
    expect(rolesOf(topology, "src/c.ts")).toEqual([
      "dependency-sink",
      "satellite",
    ]);
    expect(rolesOf(topology, "src/b.ts")).toEqual(["bridge"]);
    expect(topology.summary).toMatchObject({
      bridges: 1,
      dependencySinks: 1,
      dependencySources: 1,
      highFanIn: 0,
      highFanOut: 0,
      satellites: 2,
    });
  });
});

describe("diamond", () => {
  const topology = topologyOf({
    "src/a.ts":
      'import { b } from "./b";\nimport { c } from "./c";\nexport const a = b + c;\n',
    "src/b.ts": 'import { d } from "./d";\nexport const b = d;\n',
    "src/c.ts": 'import { d } from "./d";\nexport const c = d;\n',
    "src/d.ts": "export const d = 1;\n",
  });

  it("measures fan and layers", () => {
    expect(module(topology, "src/a.ts")).toMatchObject({ fanOut: 2, layer: 2 });
    expect(module(topology, "src/d.ts")).toMatchObject({ fanIn: 2, layer: 0 });
    expect(module(topology, "src/b.ts").layer).toBe(1);
  });

  it("finds no articulation point: every module has an alternative route", () => {
    expect(topology.summary.bridges).toBe(0);
    expect(topology.summary.weakComponents).toBe(1);
  });
});

describe("cycle a → b → c → a", () => {
  const topology = topologyOf({
    "src/a.ts":
      'import { b } from "./b";\nexport const a = (): number => b();\n',
    "src/b.ts":
      'import { c } from "./c";\nexport const b = (): number => c();\n',
    "src/c.ts":
      'import { a } from "./a";\nexport const c = (): number => a();\n',
    "src/entry.ts": 'import { a } from "./a";\nexport const entry = a();\n',
  });

  it("reports one strongly connected component with entry and exit facts", () => {
    expect(topology.cycles).toHaveLength(1);
    const [cycle] = topology.cycles;
    expect(cycle).toMatchObject({
      entryEdges: 1,
      exitEdges: 0,
      id: "cycle-1",
      internalEdges: 3,
      modules: ["src/a.ts", "src/b.ts", "src/c.ts"],
      scope: "directory",
      symbolFlow: 3,
    });
    for (const id of cycle?.modules ?? []) {
      expect(module(topology, id).cycle).toBe("cycle-1");
      expect(rolesOf(topology, id)).toContain("cycle-member");
    }
    expect(module(topology, "src/entry.ts").cycle).toBeUndefined();
  });

  it("shares one layer across the component", () => {
    const layers = ["src/a.ts", "src/b.ts", "src/c.ts"].map(
      (id) => module(topology, id).layer
    );
    expect(new Set(layers).size).toBe(1);
    expect(module(topology, "src/entry.ts").layer).toBe(1);
  });
});

describe("two cycles connected", () => {
  const topology = topologyOf({
    "src/a.ts":
      'import { b } from "./b";\nexport const a = (): number => b();\n',
    "src/b.ts":
      'import { a } from "./a";\nimport { x } from "./x";\nexport const b = (): number => a() + x();\n',
    "src/x.ts":
      'import { y } from "./y";\nexport const x = (): number => y();\n',
    "src/y.ts":
      'import { x } from "./x";\nexport const y = (): number => x();\n',
  });

  it("condenses to two components with a layer between them", () => {
    expect(topology.cycles.map((cycle) => cycle.modules)).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/x.ts", "src/y.ts"],
    ]);
    expect(module(topology, "src/x.ts").layer).toBe(0);
    expect(module(topology, "src/a.ts").layer).toBe(1);
    expect(topology.cycles[0]?.exitEdges).toBe(1);
    expect(topology.cycles[1]?.entryEdges).toBe(1);
  });
});

describe("isolated module", () => {
  const topology = topologyOf({
    ...chain,
    "src/alone.test.ts":
      'import { alone } from "./alone";\nexport const t = alone;\n',
    "src/alone.ts": "export const alone = 1;\n",
  });

  it("stays present with its file kind and the isolated role", () => {
    expect(module(topology, "src/alone.ts")).toMatchObject({
      contextFanIn: 1,
      fanIn: 0,
      fanOut: 0,
      fileKind: "source",
    });
    expect(rolesOf(topology, "src/alone.ts")).toEqual(["isolated"]);
    expect(topology.summary.weakComponents).toBe(2);
  });
});

describe("barrel", () => {
  const topology = topologyOf({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "src/consumer.ts":
      'import { a, b } from "./index";\nexport const sum = a + b;\n',
    "src/index.ts": 'export { a } from "./a";\nexport * from "./b";\n',
  });

  it("recognizes the aggregator and its re-export edges", () => {
    expect(rolesOf(topology, "src/index.ts")).toContain("aggregator");
    expect(module(topology, "src/index.ts").syntacticRole).toMatchObject({
      entrypoint: true,
      kind: "aggregator",
      reExports: 2,
    });
    const toA = topology.edges.find(
      (edge) => edge.source === "src/index.ts" && edge.target === "src/a.ts"
    );
    expect(toA).toMatchObject({ importSites: 1, reExportSites: 1 });
  });

  it("resolves mediated symbols to their declaring modules", () => {
    const edge = topology.edges.find(
      (candidate) =>
        candidate.source === "src/consumer.ts" &&
        candidate.target === "src/index.ts"
    );
    expect(edge?.symbols).toEqual([
      expect.objectContaining({
        declarationModule: "src/a.ts",
        mediated: true,
        name: "a",
        symbolId: "packages/p/src/a.ts#a",
      }),
      expect.objectContaining({
        declarationModule: "src/b.ts",
        mediated: true,
        name: "b",
      }),
    ]);
    const a = topology.consumedSurface.find((symbol) => symbol.name === "a");
    expect(a?.consumers).toEqual([
      expect.objectContaining({
        module: "src/consumer.ts",
        via: "src/index.ts",
      }),
    ]);
    expect(module(topology, "src/a.ts")).toMatchObject({
      fanIn: 1,
      providedSymbols: 1,
      symbolConsumers: 1,
    });
  });
});

describe("symbol flow", () => {
  const topology = topologyOf({
    "src/a.ts":
      'import { Foo, bar } from "./b";\nimport type { Baz } from "./b";\n\nexport const use = (x: Baz): Foo => bar(bar(x));\n',
    "src/b.ts":
      "export type Foo = number;\nexport type Baz = number;\nexport const bar = (x: number): number => x;\n",
  });

  it("aggregates one module edge with per-symbol evidence", () => {
    expect(topology.edges).toHaveLength(1);
    const [edge] = topology.edges;
    expect(edge).toMatchObject({
      bindingOccurrences: 4,
      importSites: 3,
      typeOnlySites: 1,
      valueSites: 2,
    });
    expect(edge?.symbols).toEqual([
      expect.objectContaining({
        bindingOccurrences: 2,
        mediated: false,
        name: "bar",
        symbolId: "packages/p/src/b.ts#bar",
        typeOnlySites: 0,
      }),
      expect.objectContaining({
        bindingOccurrences: 1,
        name: "Baz",
        typeOnlySites: 1,
      }),
      expect.objectContaining({
        bindingOccurrences: 1,
        name: "Foo",
        typeOnlySites: 0,
      }),
    ]);
    expect(module(topology, "src/a.ts").consumedSymbols).toBe(3);
  });

  it("keeps the type-only import distinct from value usage", () => {
    const baz = topology.consumedSurface.find(
      (symbol) => symbol.name === "Baz"
    );
    expect(baz?.consumers[0]).toMatchObject({
      importSites: 1,
      typeOnlySites: 1,
    });
    const bar = topology.consumedSurface.find(
      (symbol) => symbol.name === "bar"
    );
    expect(bar?.consumers[0]).toMatchObject({
      importSites: 1,
      typeOnlySites: 0,
    });
  });
});

const regions = {
  "src/canvas/editor/a.ts":
    'import { b } from "../runtime/b";\nimport { c } from "../../tasks/c";\nexport const a = b + c;\n',
  "src/canvas/runtime/b.ts":
    'import { c } from "../../tasks/c";\nexport const b = c;\n',
  "src/index.ts": 'export { a } from "./canvas/editor/a";\n',
  "src/tasks/c.ts": "export const c = 1;\n",
};

describe("directory hierarchy", () => {
  const topology = topologyOf(regions);

  it("builds the full tree with owning directories and path regions", () => {
    expect(topology.directories.map((directory) => directory.id)).toEqual([
      ".",
      "src",
      "src/canvas",
      "src/canvas/editor",
      "src/canvas/runtime",
      "src/tasks",
    ]);
    const canvas = topology.directories.find((d) => d.id === "src/canvas");
    expect(canvas).toMatchObject({
      childDirectories: ["src/canvas/editor", "src/canvas/runtime"],
      depth: 2,
      descendantModules: 2,
      directModules: [],
      incomingEdges: 1,
      internalEdges: 1,
      outgoingEdges: 2,
      parent: "src",
      region: "canvas",
    });
    expect(module(topology, "src/canvas/editor/a.ts")).toMatchObject({
      directory: "src/canvas/editor",
      region: "canvas",
    });
    expect(module(topology, "src/index.ts").region).toBe(".");
    expect(topology.regions.map((region) => region.id)).toEqual([
      ".",
      "canvas",
      "tasks",
    ]);
  });

  it("classifies edge locality and distance", () => {
    const editorToRuntime = topology.edges.find(
      (edge) => edge.target === "src/canvas/runtime/b.ts"
    );
    expect(editorToRuntime).toMatchObject({
      distance: 2,
      locality: "same-region",
    });
    const editorToTasks = topology.edges.find(
      (edge) =>
        edge.source === "src/canvas/editor/a.ts" &&
        edge.target === "src/tasks/c.ts"
    );
    expect(editorToTasks).toMatchObject({
      distance: 3,
      locality: "cross-region",
    });
  });
});

describe("directory seams", () => {
  const topology = topologyOf(regions);

  it("aggregates canvas → tasks with participants and concentration", () => {
    const seam = topology.seams.find(
      (candidate) => candidate.from === "canvas" && candidate.to === "tasks"
    );
    expect(seam).toMatchObject({
      aggregatorTargetShare: 0,
      importSites: 2,
      moduleEdges: 2,
      sourceModules: ["src/canvas/editor/a.ts", "src/canvas/runtime/b.ts"],
      sourceParticipation: 1,
      symbolFlow: 1,
      targetModules: ["src/tasks/c.ts"],
      targetParticipation: 1,
      topSymbol: { importSites: 2, name: "c", share: 1 },
      topTarget: { module: "src/tasks/c.ts", moduleEdges: 2, share: 1 },
    });
  });

  it("drills down to owning-directory pairs", () => {
    expect(topology.directoryEdges).toEqual([
      expect.objectContaining({
        from: "src",
        moduleEdges: 1,
        to: "src/canvas/editor",
      }),
      expect.objectContaining({
        from: "src/canvas/editor",
        to: "src/canvas/runtime",
      }),
      expect.objectContaining({ from: "src/canvas/editor", to: "src/tasks" }),
      expect.objectContaining({ from: "src/canvas/runtime", to: "src/tasks" }),
    ]);
  });

  it("keeps direction: tasks → canvas is a separate seam", () => {
    expect(
      topology.seams.find(
        (seam) => seam.from === "tasks" && seam.to === "canvas"
      )
    ).toBeUndefined();
    const reversed = topologyOf({
      ...regions,
      "src/tasks/c.ts":
        'import { b } from "../canvas/runtime/b";\nexport const c = b;\n',
    });
    const pairs = reversed.seams.map((seam) => `${seam.from}→${seam.to}`);
    expect(pairs).toContain("tasks→canvas");
    expect(pairs).toContain("canvas→tasks");
  });
});

describe("external imports", () => {
  const topology = topologyOf({
    "src/a.ts":
      'import { b } from "./b";\nimport { z } from "@external/pkg";\nimport "@external/side";\nexport const a = b + z;\n',
    "src/b.ts": "export const b = 1;\n",
  });

  it("keeps only the internal target in the graph", () => {
    expect(topology.modules.map((module) => module.id)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(topology.edges).toHaveLength(1);
    expect(module(topology, "src/a.ts")).toMatchObject({
      externalFanOut: 2,
      fanOut: 1,
    });
  });
});

describe("package-owned tsconfig paths", () => {
  const topology = topologyOf({
    "src/a.ts": 'import { b } from "~/lib/b";\nexport const a = b;\n',
    "src/lib/b.ts": "export const b = 1;\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "~/*": ["./src/*"] } },
    }),
  });

  it("resolves an alias declared by the package itself as internal", () => {
    expect(topology.edges).toEqual([
      expect.objectContaining({ source: "src/a.ts", target: "src/lib/b.ts" }),
    ]);
    expect(module(topology, "src/a.ts").externalFanOut).toBe(0);
  });
});

describe("primary versus context topology", () => {
  const topology = topologyOf({
    ...chain,
    "src/a.stories.ts": 'import { a } from "./a";\nexport const s = a;\n',
    "src/a.test.ts": 'import { a } from "./a";\nexport const t = a;\n',
  });

  it("retains test and story edges without counting them as primary", () => {
    expect(topology.summary).toMatchObject({
      contextEdgesByKind: { config: 0, other: 0, source: 0, story: 1, test: 1 },
      edges: 4,
      modules: 5,
      modulesByKind: { config: 0, other: 0, source: 3, story: 1, test: 1 },
      primaryEdges: 2,
      primaryModules: 3,
    });
    expect(module(topology, "src/a.ts")).toMatchObject({
      contextFanIn: 2,
      fanIn: 0,
    });
    expect(module(topology, "src/a.test.ts")).toMatchObject({
      fileKind: "test",
      primary: false,
    });
    expect(module(topology, "src/a.test.ts").layer).toBeUndefined();
    expect(rolesOf(topology, "src/a.ts")).toContain("dependency-source");
    expect(topology.roles.map((r) => r.module)).not.toContain("src/a.test.ts");
  });
});

describe("independence", () => {
  const serialize = (root: string) =>
    JSON.stringify(
      analyzeInternalPackageTopology(
        analyzePackageLocal({ root, target: "packages/p" })
      )
    );

  it("is byte-identical across workspaces, consumers, Git history, and clock", () => {
    const quiet = serialize(workspace(regions));
    const busy = workspace(regions, {
      "packages/q/package.json": JSON.stringify({
        dependencies: { "@f/p": "workspace:*" },
        name: "@f/q",
      }),
      "packages/q/src/index.ts":
        'import { a } from "@f/p";\nimport { c } from "@f/p/src/tasks/c";\nexport const q = a + c;\n',
      "packages/r/package.json": JSON.stringify({ name: "@f/r" }),
      "packages/r/src/index.ts": "export const r = 1;\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@f/p": ["packages/p/src/index.ts"] } },
      }),
    });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: busy });
    execFileSync("git", ["add", "-A"], { cwd: busy });
    execFileSync(
      "git",
      ["-c", "user.name=f", "-c", "user.email=f@e.test", "commit", "-qm", "x"],
      { cwd: busy }
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
      expect(serialize(busy)).toBe(quiet);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes deterministically from the same local report", () => {
    const root = workspace(regions);
    const local = analyzePackageLocal({ root, target: "packages/p" });
    const once = JSON.stringify(analyzeInternalPackageTopology(local));
    expect(JSON.stringify(analyzeInternalPackageTopology(local))).toBe(once);
    expect(
      JSON.stringify(analyzeInternalPackageTopology(structuredClone(local)))
    ).toBe(once);
  });

  it("contains no absolute paths, timestamps, or timings", () => {
    const root = workspace(regions);
    const json = serialize(root);
    expect(json.includes(root)).toBe(false);
    expect(json.includes(os.tmpdir())).toBe(false);
    expect(/\d{4}-\d{2}-\d{2}T/.test(json)).toBe(false);
    expect(/runtimeMs|elapsed|durationMs/.test(json)).toBe(false);
  });
});

describe("query helpers", () => {
  it("assembles a module neighborhood", () => {
    const topology = topologyOf(regions);
    const neighborhood = getModuleNeighborhood(
      topology,
      "src/canvas/runtime/b.ts"
    );
    expect(neighborhood?.dependencies.map((edge) => edge.target)).toEqual([
      "src/tasks/c.ts",
    ]);
    expect(neighborhood?.consumers.map((edge) => edge.source)).toEqual([
      "src/canvas/editor/a.ts",
    ]);
    expect(neighborhood?.provided.map((symbol) => symbol.name)).toEqual(["b"]);
    expect(neighborhood?.directory?.id).toBe("src/canvas/runtime");
  });
});
