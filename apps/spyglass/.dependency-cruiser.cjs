"use strict";
/**
 * The viewer's layer direction, from `docs/spyglass/_renderer.md`. The leaves
 * import only leaves above them in the order data, settings, view, ladder;
 * `layout/` imports leaves and layout; `scene/` imports leaves, layout and
 * scene; `interaction/` imports those and itself, never `ui/`; `ui/` sees
 * everything; `main.tsx` is the entry nothing imports, and
 * `timings.ts`, the load and stage instrumentation, is read by any layer.
 * Both of those are the only modules directly under `src/web`. The library
 * under `src/lib` is below every layer, as it is for the data leaf.
 * Type-only imports count, so a type that would cross the direction moves
 * to the right layer instead.
 *
 * Run with `bun run check:layers`.
 */

const timings = "^src/web/timings\\.ts$";

const layer = (name, allowed) => ({
  comment: `src/web/${name} may import only ${allowed.join(", ")}.`,
  from: { path: `^src/web/${name}/` },
  name: `${name}-imports-below-only`,
  severity: "error",
  to: {
    path: "^src/",
    pathNot: [...allowed.map((folder) => `^src/${folder}/`), timings],
  },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    layer("data", ["lib", "web/data"]),
    layer("settings", ["web/data", "web/settings"]),
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
    layer("scene", [
      "lib",
      "web/data",
      "web/settings",
      "web/view",
      "web/ladder",
      "web/layout",
      "web/scene",
    ]),
    layer("interaction", [
      "lib",
      "web/data",
      "web/settings",
      "web/view",
      "web/ladder",
      "web/layout",
      "web/scene",
      "web/interaction",
    ]),
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
    includeOnly: { path: "^src/" },
    reporterOptions: {
      text: { highlightFocused: true },
    },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
