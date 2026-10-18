"use strict";
/**
 * The viewer's layer direction, from `docs/spyglass/_renderer.md`. The leaves
 * import only leaves above them in the order data, settings, view, ladder;
 * layout (every module directly under `src/web`) imports leaves; `scene/`
 * imports leaves and layout; `ui/` sees everything; `main.tsx` is the entry
 * nothing imports. Type-only imports count, so a type that would cross the
 * direction moves to the right layer instead.
 *
 * Run with `bun run check:layers`.
 */

const leaf = (name, allowed) => ({
  comment: `src/web/${name} is a leaf: it may import only ${allowed.join(", ")}.`,
  from: { path: `^src/web/${name}/` },
  name: `${name}-imports-leaves-only`,
  severity: "error",
  to: {
    path: "^src/",
    pathNot: allowed.map((folder) => `^src/${folder}/`),
  },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    leaf("data", ["lib", "web/data"]),
    leaf("settings", ["web/data", "web/settings"]),
    leaf("view", ["web/data", "web/settings", "web/view"]),
    leaf("ladder", ["web/data", "web/settings", "web/view", "web/ladder"]),
    {
      comment:
        "Layout, every module directly under src/web, imports leaves and other layout; never scene or ui. main.tsx, the entry that mounts the app, is the one host module outside ui.",
      from: {
        path: "^src/web/[^/]+\\.tsx?$",
        pathNot: "^src/web/main\\.tsx$",
      },
      name: "layout-never-imports-scene-or-ui",
      severity: "error",
      to: { path: "^src/web/(scene|ui)/" },
    },
    {
      comment: "scene imports leaves and layout; the React host is above it.",
      from: { path: "^src/web/scene/" },
      name: "scene-never-imports-ui",
      severity: "error",
      to: { path: "^src/web/ui/" },
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
