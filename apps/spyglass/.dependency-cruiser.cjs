"use strict";
/**
 * The viewer's layer direction. The leaves
 * import only leaves above them in the order data, settings, view, ladder;
 * `layout/` imports leaves and layout; `interaction/` imports those and
 * itself; `islands-host/`, the bridge to the Islands renderer, imports
 * those and itself, and only its `islands-api.ts` imports the renderer;
 * the one exception is the copy's `lab/params.ts`, the framework-free
 * vocabulary settings are declared in (`defineParams`, the group layout),
 * which `settings/` and `ui/` import directly;
 * `ui/` sees everything; `islands/`, the
 * renderer's synced copy, owned by another repository, is unrestricted
 * here; `main.tsx` is the entry nothing imports, and
 * `timings.ts`, the load and stage instrumentation, is read by any layer.
 * Both of those are the only modules directly under `src/web`. The library
 * under `src/lib` is below every layer, as it is for the data leaf.
 * Type-only imports count, so a type that would cross the direction moves
 * to the right layer instead.
 *
 * `test/lib/layers.test.ts` checks them.
 */

// Computational preparation stays usable in scans and browsers. read.ts and
// write.ts are adapters; storage and renderer dependencies do not belong here.
const pureVisualization =
  "^src/lib/visualization/(affinity|coast-collision|distance-field|scanline-fill|foundations|geography|geology|groups|island-geometry|prepare|sea-stacks|terrain|types)\\.ts$";

const timings = "^src/web/timings\\.ts$";

/**
 * The settings vocabulary in the renderer's synced copy: schema types and
 * pure functions, no renderer code. Settings are declared in it.
 */
const params = "^src/web/islands/lab/params\\.ts$";

const layer = (name, allowed, files = []) => ({
  comment: `src/web/${name} may import only ${[...allowed, ...files].join(", ")}.`,
  from: { path: `^src/web/${name}/` },
  name: `${name}-imports-below-only`,
  severity: "error",
  to: {
    path: "^src/",
    pathNot: [...allowed.map((folder) => `^src/${folder}/`), ...files, timings],
  },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      comment:
        "Pure visualization preparation imports only geometry, manifest types, and pure file placement.",
      from: { path: pureVisualization },
      name: "visualization-preparation-is-independent",
      severity: "error",
      to: {
        path: "^src/",
        pathNot: [
          pureVisualization,
          "^src/lib/(file-placement|dependency-inventory-types|dependency-graph-types|semantics-types)\\.ts$",
        ],
      },
    },
    {
      comment:
        "Preparation does not depend on Node built-ins or rendering frameworks.",
      from: { path: pureVisualization },
      name: "visualization-preparation-has-no-runtime-platform",
      severity: "error",
      to: {
        path: "^node:|^bun:|^[^/]+$|(^|/)node_modules/(react|react-dom)/",
      },
    },
    layer("data", ["lib", "web/data"]),
    layer("settings", ["web/data", "web/settings"], [params]),
    layer("view", ["web/data", "web/settings", "web/view"]),
    layer("ladder", ["web/data", "web/settings", "web/view", "web/ladder"]),
    layer("layout", [
      "lib",
      "web/data",
      "web/settings",
      "web/view",
      "web/ladder",
      "web/layout",
    ]),
    layer("interaction", [
      "lib",
      "web/data",
      "web/settings",
      "web/view",
      "web/ladder",
      "web/layout",
      "web/interaction",
    ]),
    layer("islands-host", [
      "lib",
      "web/data",
      "web/settings",
      "web/view",
      "web/ladder",
      "web/layout",
      "web/interaction",
      "web/islands",
      "web/islands-host",
    ]),
    {
      comment:
        "The viewer reaches the Islands renderer's synced copy only through islands-host/islands-api.ts, but for the settings vocabulary, lab/params.ts.",
      from: {
        pathNot: [
          "^src/web/islands/",
          "^src/web/islands-host/islands-api\\.ts$",
        ],
      },
      name: "islands-only-through-the-host",
      severity: "error",
      to: { path: "^src/web/islands/", pathNot: [params] },
    },
    {
      comment:
        "Only main.tsx and timings.ts sit directly under src/web; every other module belongs to a layer folder. (A stray module that imports anything.)",
      from: {
        path: "^src/web/[^/]+\\.tsx?$",
        pathNot: ["^src/web/main\\.tsx$", timings],
      },
      name: "no-stray-root-modules",
      severity: "error",
      to: {},
    },
    {
      comment:
        "Only main.tsx and timings.ts sit directly under src/web; every other module belongs to a layer folder. (A stray module that anything imports.)",
      from: {},
      name: "nothing-imports-stray-root-modules",
      severity: "error",
      to: {
        path: "^src/web/[^/]+\\.tsx?$",
        pathNot: ["^src/web/main\\.tsx$", timings],
      },
    },
    {
      comment: "main.tsx is the entry; nothing imports it.",
      from: {},
      name: "nothing-imports-main",
      severity: "error",
      to: { path: "^src/web/main\\.tsx$" },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    enhancedResolveOptions: {
      conditionNames: ["import", "require", "node", "default", "types"],
      exportsFields: ["exports"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs"],
      mainFields: ["module", "main", "types", "typings"],
    },
    includeOnly: {
      path: "^src/|^node:|^bun:|^[^/]+$|(^|/)node_modules/(react|react-dom)/",
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
