# Generation

The pipeline that turns a request for missing glyphs into candidates a
project can propose. It is organised around stages and outcomes, never around
a provider. Whatever drew a glyph (a rule, an image model, a vector model, a
recorded run), the result is the same `Candidate` with provenance.

Pure TypeScript. It runs in Node and in the browser. The one file that uses
browser globals is `browser-image-codec.ts`.

## Stages

| Stage | Where | What it does |
| --- | --- | --- |
| Analyse | `style/reference.ts` | `analyseStyle` measures a face: lines, stems, contrast, overshoot, slant, sidebearings, density. `style/reference-sheet.ts` draws the sheet a model is shown. |
| Plan | `plan/plan.ts` | `planCharacters`, `planOblique`, `planSmallCapitals`, `planForm` decide the targets, with parts before the glyphs made from them. |
| Generate | `strategies/` | A `GenerationStrategy` returns raw output: outlines, a picture of a sheet, or an SVG sheet. |
| Extract | `extraction/` | `extractRasterSheet` and `extractSvgSheet` find the cells from the ink and cut one glyph out of each. |
| Normalise | `normalise/` | `normaliseSheet` scales to font units from a height model, sets the baseline, spaces and cleans. |
| Compose | `compose/compose.ts` | The seam for relationships between glyphs. Today `composeIndependently` leaves each glyph alone. |
| Validate | `evaluation/` | `evaluateGlyph` checks geometry, style and, with a holdout glyph, shape agreement. |
| Refine | `refinement/refine.ts` | `refineGlyph` applies the corrections an evaluation marked as automatic. |
| Integrate | `pipeline/stages.ts` | `integrateStage` makes candidates with provenance. |

`pipeline/run.ts` has `runGeneration`, which runs Generate to Integrate,
reports each stage through `onProgress`, and returns candidates, evaluations,
every intermediate artefact and a run record. Analyse and Plan come first:
their results are what a run is asked with. A strategy that returns outlines
skips Extract and Normalise.

## Strategies

| Strategy | File | Needs |
| --- | --- | --- |
| Procedural | `strategies/procedural/procedural.ts` | Nothing. Composites from base and mark, obliques, small capitals. |
| Image model | `strategies/image-model.ts` | An `ImageModelClient` and a PNG encoder. |
| Vector model | `strategies/vector-model.ts` | A `VectorModelClient` and a PNG encoder. |
| Recorded run | `strategies/recorded/recorded-run.ts` | A recorded run loaded from files. |

`strategies/fal/` has the two clients for fal's HTTP API. A client with no
key reports itself unavailable with the reason. `runGeneration` then throws
`StrategyUnavailableError`. It never tries another strategy in its place.

## Honesty

Provenance says what made a candidate. A replayed recording keeps the
strategy, model, run id and time of the real call and carries
`recorded: true`. An output marked `synthetic` was made without a model: its
candidates name the strategy `synthetic-sheet` and no model.

## Recorded runs

A recorded run is a directory with a `run.json` manifest and the raw files it
names. One manifest can hold several outputs made from the same request.
`loadRecordedRuns(manifestText, files)` reads it, with `files` mapping each
file name in the directory to its bytes.

```json
{
  "id": "2026-11-10-latin-holdout",
  "createdAt": "2026-11-10T05:08:03Z",
  "targets": ["R", "G", "a", "g", "k", "2"],
  "layout": { "columns": 3, "rows": 2 },
  "reference": { "file": "reference.png", "vector": "reference.svg" },
  "outputs": [
    {
      "strategy": "image-model",
      "model": "openai/gpt-image-2.6/flare/edit",
      "kind": "sheet-image",
      "file": "gpt-image-2.6-low.png",
      "promptFile": "prompt-image-sheet.txt",
      "parameters": { "quality": "low" },
      "latencySeconds": 9.86,
      "costUsd": null
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Names the run. With the output's label it is the run id in provenance: `id#label`. |
| `createdAt` | yes | When the models were called, ISO 8601. |
| `targets` | yes, here or per output | The texts on the sheet in reading order, row by row. One character is a character target. Several characters are one form, such as a conjunct. |
| `layout.columns` | yes, here or per output | Columns of the grid that was asked for. |
| `layout.rows` | when the sheet has more cells than targets | Rows of the grid. Cells past the last target are reported as extra and not used. |
| `layout.baseline`, `layout.emShare` | no | Where the baseline was asked to sit in a cell, from the top, and the share of a cell's height one em takes. Default 0.72 and 0.62. Only used when no target has known lines. |
| `reference.vector` | no | The SVG of the style reference sheet, kept with the run's artefacts. |
| `sourceFont.file` | no | The file name of the font the reference was drawn from. The replay script calls a comparison a holdout only against this font. |
| `outputs[].strategy` | yes | `image-model` or `vector-model`. |
| `outputs[].model` | yes | The model as the provider names it. |
| `outputs[].kind` | yes | `sheet-image` (PNG or JPEG) or `sheet-svg`. |
| `outputs[].file` | yes | The raw output, beside the manifest. |
| `outputs[].name` | when two outputs share a strategy | The output's label. The strategy when absent. |
| `outputs[].prompt` or `promptFile` | no | The prompt, or a text file that holds it. |
| `outputs[].parameters` | no | The settings the call was made with. |
| `outputs[].latencySeconds` | no | How long the call took. |
| `outputs[].costUsd` | no | The charge, when the provider stated it. `null` when it did not. |
| `outputs[].requested`, `outputs[].layout` | no | Override `targets` and `layout` for one output. |
| `outputs[].synthetic` | no | `true` for a sheet no model made. |

Other fields are ignored, so a manifest can carry notes. A field the table
names has to be what the table says: `"synthetic": "false"` in quotes is
refused, not read as true. Only `costUsd` may be `null`.

## Replaying a run in Node

```sh
bun scripts/generation/run-recorded.ts <run directory> <font file> \
  [--out <directory>] [--output <label>] \
  [--compare <font file>] [--zone <bottom>,<top>]
```

For each output it writes `<label>.report.json` and `<label>.contact.svg`.
The contact sheet draws every candidate in blue over the glyph it is compared
with in grey. When the manifest names the given font as its `sourceFont` and
that font has the character, the comparison is with the font's own glyph: a
holdout test. Otherwise it is with the `--compare` font's glyph, which checks
letter identity and says nothing about style. With neither, nothing is
compared and no shape score is given. `--zone` gives the two lines every glyph stands
between, for scripts the Latin height model has no lines for.
