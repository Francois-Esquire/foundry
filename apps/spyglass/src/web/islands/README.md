# Islands (synced copy)

This folder is a byte-for-byte copy of the Islands WebGPU renderer, kept in
sync with its source by a script. Do not format or lint it. Change the
source and push, or change it here and pull the change back.

Source: `/Users/miketobia/code/experiments/prototypes/apps/web/src`. The
folder mirrors that tree at the same relative paths, so every relative
import, in TypeScript and in WGSL, resolves unchanged. The entry is
`gpu/islands/api/index.ts` (`<IslandsCanvas>`, `useIslands`,
`useIslandsFrame`, the public types, and the Foundry dataset adapter,
`chartFromFoundry` from `data/foundry.ts`).

The file set is computed, not listed: everything the entry, the parameters
and the adapter reach, followed through TypeScript imports and asset URLs
and through WGSL imports as vgpu resolves them, plus the renderer's notes.
Tests, the Node tools and the fixtures stay in the prototype, and so do
their runs.

From the prototype's apps/web, naming this Spyglass app (the folder that
holds `src/web/islands`) with `--target` or the `SPYGLASS_APP`
environment variable; there is no default:

    export SPYGLASS_APP=<path to apps/spyglass>
    bun src/gpu/islands/tools/sync-spyglass.ts check
    bun src/gpu/islands/tools/sync-spyglass.ts push [--dry-run] [--force]
    bun src/gpu/islands/tools/sync-spyglass.ts pull [--dry-run] [--force]

or `bun src/gpu/islands/tools/sync-spyglass.ts check --target <path to apps/spyglass>`.

`sync.json` records each file's SHA-256 at the last sync and the commit it
came from, so a check can tell which side changed. When the prototype had
uncommitted changes, `dirty` is true and `dirtyFiles` lists the synced
files that differed from that commit; a check warns about it. This README
and `sync.json`, here at the folder's root, belong to Spyglass alone: a
check ignores them, and a push writes them. Any other file here that the
prototype does not hold, including a README.md in a subfolder, is reported
as extra.
