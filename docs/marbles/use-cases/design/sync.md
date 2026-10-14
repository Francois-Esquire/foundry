---
title: Keep tokens in sync
description: Check a Figma library on a schedule and propose its color palette as a pull request.
---

A design system lives in two places: the Figma library designers publish, and
the tokens the code reads. This module checks the library every hour, reads
its color styles when the file has changed, and has an agent propose the new
palette as a pull request.

Use this after the [design handoff](/marbles/use-cases/design/deliver).
The integration proposes a change; a person still reviews the resulting
tokens and the screens that use them. The module can push and open a PR
without an in-run approval. Enable its schedule only when those proposals
are authorized, and keep merge decisions with the project's owner.

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
connects the deterministic checks to the agent step;
[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
provides its Git checkout, and [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
provides the coding session. The step boundaries record which stages
completed, while Git keeps the proposed code and palette snapshot.

## Before you start

Install the [Marbles CLI](/marbles/get-started/installation), an authenticated
Claude Code or Codex CLI, and `zod@4.4.3` in your project. Use a Git repository
with a `main` branch and an existing color-token system. This example can
commit, push, and open a pull request when run for real.

You also need a Figma personal access token with the `file_metadata:read`,
`file_content:read`, and `library_content:read` scopes, the key of the library
file (`figma.com/design/<file key>/…`), an authenticated `gh`, and permission to push branches to the repository.

## Write the automation

Save the complete module below as `.foundry/marbles/design-sync.ts`.
The [Figma file API](https://developers.figma.com/docs/rest-api/file-endpoints/)
and [published style API](https://developers.figma.com/docs/rest-api/component-endpoints/)
supply the data:

| Step | Request | What it reads |
| --- | --- | --- |
| `check` | `GET /v1/files/:key/meta` | `file.version`, which changes with every saved version of the file. |
| `extract` | `GET /v1/files/:key/styles` | The published styles: `node_id`, `name`, and `style_type`. |
| `extract` | `GET /v1/files/:key/nodes?ids=…` | Each style node's `fills`. A `SOLID` paint has `color: { r, g, b, a }`, channels from 0 to 1. |

<details>
<summary>Complete design-sync.ts</summary>

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agent, schedule, step, workflow } from "@foundry/marbles";
import { z } from "zod";

// What the Figma REST API returns, trimmed to the fields this module reads.
// @figma/rest-api-spec has the complete types.
type RGBA = { r: number; g: number; b: number; a: number };
type FileMeta = {
  file: { name: string; version?: string; last_touched_at: string };
};
type FileStyles = {
  meta: { styles: { node_id: string; name: string; style_type: string }[] };
};
type FileNodes = {
  nodes: Record<
    string,
    {
      document: { fills?: { type: string; color?: RGBA; opacity?: number }[] };
    } | null
  >;
};

async function figma<T>(path: string, signal: AbortSignal): Promise<T> {
  const token = process.env.FIGMA_TOKEN;
  if (!token)
    throw new Error("Set FIGMA_TOKEN to a Figma personal access token");
  const response = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": token },
    signal,
  });
  if (!response.ok)
    throw new Error(`Figma ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

const channel = (value: number) =>
  Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");
const hex = ({ r, g, b, a }: RGBA, opacity = 1) =>
  `#${channel(r)}${channel(g)}${channel(b)}${a * opacity < 1 ? channel(a * opacity) : ""}`;

// The last palette merged into this repository. Each pull request updates it.
const SNAPSHOT = "design/figma-palette.json";
const snapshotFile = z.object({
  file: z.string(),
  version: z.string(),
  colors: z.array(z.object({ name: z.string(), hex: z.string() })),
});
const checked = z.object({
  file: z.string(),
  version: z.string(),
  changed: z.boolean(),
});
const extracted = snapshotFile.extend({
  changed: z.boolean(),
  digest: z.string(),
});

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
    if (!check.changed)
      return { file, version, colors: [], changed: false, digest: "" };

    const { meta } = await figma<FileStyles>(`/files/${file}/styles`, signal);
    const fills = meta.styles.filter((style) => style.style_type === "FILL");
    const ids = encodeURIComponent(
      fills.map((style) => style.node_id).join(",")
    );
    const { nodes } = fills.length
      ? await figma<FileNodes>(`/files/${file}/nodes?ids=${ids}`, signal)
      : { nodes: {} as FileNodes["nodes"] };

    const colors = fills.flatMap((style) => {
      const paint = nodes[style.node_id]?.document.fills?.[0];
      if (paint?.type !== "SOLID" || !paint.color) {
        log.warn(
          "skipping",
          style.name,
          "with a",
          paint?.type ?? "missing",
          "fill"
        );
        return [];
      }
      return [{ name: style.name, hex: hex(paint.color, paint.opacity) }];
    });
    colors.sort((a, b) => a.name.localeCompare(b.name));

    const digest = createHash("sha256")
      .update(JSON.stringify(colors))
      .digest("hex")
      .slice(0, 8);
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
    const reply = await git.withWorktree(
      { base: "main", branch },
      async (worktree) => {
        const path = join(worktree.root, SNAPSHOT);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          `${JSON.stringify({ file, version, colors }, null, 2)}\n`
        );

        const session = await agents.session(designer);
        return session.generate(
          `${SNAPSHOT} now holds the color styles published in Figma. ` +
            "Update this repository's color tokens to match, wherever they live. " +
            `Commit everything on ${branch}, push it, and open a pull request with gh ` +
            "that lists the colors added, changed, and removed."
        );
      }
    );

    report.result({ title: `Palette ${palette.digest}`, body: reply.text });
    return branch;
  });

const designSync = workflow("design-sync")
  .input(z.object({ file: z.string() }))
  .do(({ input: { file } }) =>
    propose({ palette: extract({ check: check({}, { file }) }) })
  );

// The key from the library file's URL.
schedule(designSync({}, { file: "your-file-key" })).every("1h");
```

</details>

## Run and verify

Set the file key in the schedule before starting the dashboard. Replace
`YOUR_FILE_KEY` in the one-shot command as well. For persistent setup,
declare the token through [Varlock](/marbles/reference/project#environment).

```sh
export FIGMA_TOKEN=figd_…
marbles list
marbles roll design-sync --input '{"file":"YOUR_FILE_KEY"}' --dry-run
marbles
```

Under `--dry-run` the Figma requests are real; the worktree's Git commands
and the agent turn are echoed, so you can see the palette and the prompt
without a branch or a pull request. The raw snapshot file write still happens
in a temporary directory. Drop `--dry-run` to propose for real, then inspect
the returned branch and its pull request. Verify the actual token changes
and the palette snapshot before merging.

`report.result(...)` posts the agent's explanation to the Feed. This sample
keeps the palette snapshot in Git rather than declaring an output artifact.
To retain additional screenshots or review evidence, use
[`report.artifact(...)`](/marbles/foundation/artifacts-and-results#choose-an-output)
with saved files and a readable Feed body.

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
  holds the last merged palette. The pull request updates it; Git supplies
  the comparison baseline for the next run.
- **One pull request per palette.** The branch is named after the palette's
  digest. While that branch exists, the same palette is not proposed again;
  delete the branch to propose it again after closing its pull request.
- **Code detects, the agent maps.** The module decides what changed. The
  agent decides where this repository keeps its tokens (CSS custom
  properties, a Tailwind theme, a tokens file) and how to update them.

This integration requires live Figma and GitHub access to validate end to end.
Loading the module or echoing the agent does not verify the external services.

The branch check avoids proposing an existing palette again, but does not
prove that a previous attempt finished pushing or opening its pull request.
Inspect that branch and remote state after a partial failure before rerunning
or enabling retries. [Durability](/marbles/foundation/durability) keeps the
workflow's recorded progress; it cannot make an external commit, push, and
pull-request creation one atomic operation.

## Variations

- **Variables instead of styles.** Libraries that define color as variables
  read `GET /v1/files/:key/variables/local` instead of the two style
  requests. It returns `meta.variables`, each with a `resolvedType` such as
  `COLOR` and `valuesByMode` keyed by mode, such as light and dark. The
  [Variables API](https://developers.figma.com/docs/rest-api/variables-endpoints/)
  has separate access and scope requirements.
- **Figma's MCP server.** Give the agent Figma's MCP server in Claude Code
  or Codex and let it read the variables with `get_variable_defs`, given a
  link to the frame that holds the tokens. Keep
  `check` as the deterministic gate, so the agent runs only when the file
  was saved.
- **A monitor as the gate.** `monitor(url).request(() => ({ headers:
  { "X-Figma-Token": process.env.FIGMA_TOKEN ?? "" } }))` polls `/meta`
  without a step, and its handler can return `designSync({}, { file })`.
  The monitor fires on any change to the response, so keep `check`'s
  version comparison: a field that changes on every request, such as a
  signed thumbnail URL, would otherwise start the workflow every hour.
- **More than color.** `style_type` is also `TEXT`, `EFFECT`, or `GRID`.
  A text style's node carries its font in `style`.

## Limits

Figma rate-limits requests by endpoint and plan. Handle `429` responses
according to its [rate-limit guidance](https://developers.figma.com/docs/rest-api/rate-limits/);
an hourly cadence is not a quota guarantee. This example throws on a failed
request and tries again on a later scheduled tick while Marbles is running. Declare `FIGMA_TOKEN`
in the workspace's `.env.schema` (it can read the token from the Keychain).
Marbles resolves it when the process starts, before importing the modules;
see [environment loading](/marbles/reference/project#environment).
