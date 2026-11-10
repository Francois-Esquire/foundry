# Progress

The acceptance ledger for the typography studio. One row per criterion in the
brief, with the test or script that proves it. Updated at each milestone.

Status words: done (verified by the named evidence), partial, not started,
unavailable (blocked by something outside the repo, with the reason).

## Decisions

| Decision | Why |
| --- | --- |
| HarfBuzz (`harfbuzzjs` 1.6.4) reads and shapes fonts. | One engine for cmap, outlines, axes and shaping, so inspection and shaping never disagree. Verified in Node and in Chrome. |
| fontTools 4.62.1 on Pyodide 314.0.7 builds fonts, in a worker. | It is the established tool for compiling, merging layout, subsetting and instancing. Cold start is about 1.2 s in Chrome. Runtime and wheels are served from `public/engine`, so fonts never leave the browser. |
| fontkit was tried and dropped. | HarfBuzz covers what it offered, and a second parser could disagree with the shaper. |
| Feature code is grafted onto existing layout tables. | fontTools' feature compiler replaces GSUB and GPOS. The engine compiles into a shadow font and merges lookups, features and scripts, so source shaping survives. |
| Edits to a variable face go through a pinned instance. | Changing one master's outline would break the variation data. |
| One app, `apps/typography`, with a directory per bounded context. | See `CONTEXT.md`. No packages until a second consumer exists. |

## Acceptance ledger

| Phase | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Import two fonts with different script coverage, one variable | `test/engines/harfbuzz-reader.test.ts` | partial: reading done, interface not started |
| 1 | Correct coverage | | not started |
| 1 | Working specimen controls | | not started |
| 1 | Unchanged original-file export | `test/spine.test.ts` "leaves the source untouched" | partial: model done, interface not started |
| 2 | Edit a glyph or its metrics, preview in text, source preserved | `test/spine.test.ts` | partial: model and build done, interface not started |
| 3 | Modified font loads independently with intended coverage and shaping | `test/spine.test.ts` | partial: engine validation done, independent validation not started |
| 4 | Real generated candidates, normalised, refined, in a derived font | | not started |
| 5 | A defined script extension with functional shaping | | not started |
| 6 | Coordinated faces or a valid variable font | | not started |
| 7 | Usable candidates recovered from a real image, editable | | not started |
| 8 | Integrated workflows end to end | | not started |

## Resource usage

No paid model calls yet.

## Delegated work

None running.
