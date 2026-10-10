---
title: Design Sync
description: Check a Figma library on a schedule and propose its color palette as a pull request.
---

A design system lives in two places: the Figma library designers publish, and
the tokens the code reads. This module checks the library every hour, reads
its color styles when the file has changed, and has an agent propose the new
palette as a pull request.

You need a Figma personal access token with the `file_metadata:read`,
`file_content:read`, and `library_content:read` scopes, the key of the library
file (`figma.com/design/<file key>/…`), an authenticated `gh`, and `zod`.

Three requests to the Figma REST API do the reading:

| Step | Request | What it reads |
| --- | --- | --- |
| `check` | `GET /v1/files/:key/meta` | `file.version`, which changes with every saved version of the file. |
| `extract` | `GET /v1/files/:key/styles` | The published styles: `node_id`, `name`, and `style_type`. |
| `extract` | `GET /v1/files/:key/nodes?ids=…` | Each style node's `fills`. A `SOLID` paint has `color: { r, g, b, a }`, channels from 0 to 1. |

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agent, schedule, step, workflow } from "@foundry/marbles";
import { z } from "zod";

// What the Figma REST API returns, trimmed to the fields this module reads.
// @figma/rest-api-spec has the complete types.
type RGBA = { r: number; g: number; b: number; a: number };
type FileMeta = { file: { name: string; version?: string; last_touched_at: string } };
type FileStyles = { meta: { styles: { node_id: string; name: string; style_type: string }[] } };
type FileNodes = {
  nodes: Record<string, { document: { fills?: { type: string; color?: RGBA; opacity?: number }[] } } | null>;
};

async function figma<T>(path: string, signal: AbortSignal): Promise<T> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("Set FIGMA_TOKEN to a Figma personal access token");
  const response = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": token },
    signal,
  });
  if (!response.ok) throw new Error(`Figma ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
const hex = ({ r, g, b, a }: RGBA, opacity = 1) =>
  `#${channel(r)}${channel(g)}${channel(b)}${a * opacity < 1 ? channel(a * opacity) : ""}`;

// The last palette merged into this repository. Each pull request updates it.
const SNAPSHOT = "design/figma-palette.json";
const snapshotFile = z.object({
  file: z.string(),
  version: z.string(),
  colors: z.array(z.object({ name: z.string(), hex: z.string() })),
});
const checked = z.object({ file: z.string(), version: z.string(), changed: z.boolean() });
const extracted = snapshotFile.extend({ changed: z.boolean(), digest: z.string() });

const readSnapshot = (root: string) =>
  readFile(join(root, SNAPSHOT), "utf8")
    .then((text) => snapshotFile.parse(JSON.parse(text)))
    .catch(() => undefined);

// Has the file been saved since the snapshot? One small request.
const check = step("check")
  .input(z.object({ file: z.string() }))
  .output(checked)
  .do(async ({ input: { file }, workspaces, signal, log }) => {
    const { file: meta } = await figma<FileMeta>(`/files/${file}/meta`, signal);
    const version = meta.version ?? meta.last_touched_at;
    const snapshot = await readSnapshot(workspaces.current.root);
    log(meta.name, "version", version, "snapshot", snapshot?.version ?? "none");
    return { file, version, changed: version !== snapshot?.version };
  });

// Read the published color styles and compare them with the snapshot.
const extract = step("extract")
  .input(z.object({ check: checked }))
  .output(extracted)
  .do(async ({ input: { check }, workspaces, signal, log }) => {
    const { file, version } = check;
    if (!check.changed) return { file, version, colors: [], changed: false, digest: "" };

    const { meta } = await figma<FileStyles>(`/files/${file}/styles`, signal);
    const fills = meta.styles.filter((style) => style.style_type === "FILL");
    const ids = encodeURIComponent(fills.map((style) => style.node_id).join(","));
    const { nodes } = await figma<FileNodes>(`/files/${file}/nodes?ids=${ids}`, signal);

    const colors = fills.flatMap((style) => {
      const paint = nodes[style.node_id]?.document.fills?.[0];
      if (paint?.type !== "SOLID" || !paint.color) {
        log.warn("skipping", style.name, "with a", paint?.type ?? "missing", "fill");
        return [];
      }
      return [{ name: style.name, hex: hex(paint.color, paint.opacity) }];
    });
    colors.sort((a, b) => a.name.localeCompare(b.name));

    const digest = createHash("sha256").update(JSON.stringify(colors)).digest("hex").slice(0, 8);
    const snapshot = await readSnapshot(workspaces.current.root);
    const changed = JSON.stringify(colors) !== JSON.stringify(snapshot?.colors);
    return { file, version, colors, changed, digest };
  });

const designer = agent({
  prompt:
    "You keep this repository's design tokens in step with Figma. Change only color tokens. " +
    "Do not rename tokens the palette does not mention.",
});

// Propose a changed palette as a pull request, once per palette.
const propose = step("propose")
  .input(z.object({ palette: extracted }))
  .output(z.string())
  .do(async ({ input: { palette }, agents, workspaces, report }) => {
    if (!palette.changed) return "unchanged";

    const branch = `design/palette-${palette.digest}`;
    const { git } = workspaces.current;
    if (await git.hasBranch(branch)) return `already proposed on ${branch}`;

    const { file, version, colors } = palette;
    const reply = await git.withWorktree({ base: "main", branch }, async (worktree) => {
      const path = join(worktree.root, SNAPSHOT);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ file, version, colors }, null, 2)}\n`);

      const session = await agents.session(designer);
      return session.generate(
        `${SNAPSHOT} now holds the color styles published in Figma. ` +
          "Update this repository's color tokens to match, wherever they live. " +
          `Commit everything on ${branch}, push it, and open a pull request with gh ` +
          "that lists the colors added, changed, and removed."
      );
    });

    report.result({ title: `Palette ${palette.digest}`, body: reply.text });
    return branch;
  });

const designSync = workflow("design-sync")
  .input(z.object({ file: z.string() }))
  .do(({ input: { file } }) => propose({ palette: extract({ check: check({}, { file }) }) }));

// The key from the library file's URL.
schedule(designSync({}, { file: "your-file-key" })).every("1h");
```

```sh
export FIGMA_TOKEN=figd_…
marbles list
marbles roll <the schedule key list printed> --dry-run
marbles
```

Under `--dry-run` the Figma requests are real; the worktree's Git commands
and the agent turn are echoed, so you can see the palette and the prompt
without a branch or a pull request. Drop it to propose for real.

## How the pieces fit

```text
design-sync (propose)
└─ palette   extract
   └─ check  check { file }
```

Each step hands its result to its parent, so the tree is the order of work:
`check` asks whether anything was saved, `extract` reads the palette and
decides whether it differs, and `propose` acts only on a different palette.

- **The version is a cheap gate.** Figma bumps `version` for every saved
  version, not only palette edits, so `extract` compares the colors
  themselves. A layout change costs two more requests and ends at
  `unchanged`.
- **The snapshot is the memory.** `design/figma-palette.json` on `main`
  holds the last merged palette. The pull request updates it, so nothing is
  kept outside Git.
- **One pull request per palette.** The branch is named after the palette's
  digest. While that branch exists, the same palette is not proposed again;
  delete the branch to propose it again after closing its pull request.
- **Code detects, the agent maps.** The module decides what changed. The
  agent decides where this repository keeps its tokens (CSS custom
  properties, a Tailwind theme, a tokens file) and how to update them.

## Variations

- **Variables instead of styles.** Libraries that define color as variables
  read `GET /v1/files/:key/variables/local` instead of the two style
  requests. It returns `meta.variables`, each with a `resolvedType` such as
  `COLOR` and `valuesByMode` keyed by mode, such as light and dark. The
  endpoint is available to Enterprise organizations.
- **Figma's MCP server.** Give the agent Figma's MCP server in Claude Code
  or Codex and let it read the variables with `get_variable_defs`, given a
  link to the frame that holds the tokens. Keep
  `check` as the deterministic gate, so the agent runs only when the file
  was saved.
- **More than color.** `style_type` is also `TEXT`, `EFFECT`, or `GRID`.
  A text style's node carries its font in `style`.

## Limits

HTTP monitors fetch without request headers, and Figma requires
`X-Figma-Token`, so a scheduled step makes the request itself. Figma
rate-limits requests by endpoint and plan and answers `429` with
`Retry-After`; an hourly check stays well inside it, and a failed tick is
tried again on the next one. A [launchd](/marbles/reference/launchd) tick
receives only `PATH`, so `FIGMA_TOKEN` does not reach it; run the schedule
from the dashboard, or read the token from the Keychain inside `figma()`.
