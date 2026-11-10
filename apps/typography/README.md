# Typography

A creative typography studio that runs in the browser. Import a typeface,
explore what it covers across the world's writing systems, edit glyphs, generate
or reconstruct the ones it lacks, and export a derived font. The project lives
in memory and no font leaves the machine. It is a prototype: reloading the page
starts an empty project.

`CONTEXT.md` defines the vocabulary and the directory boundaries. `DESIGN.md`
records the design system. `PROGRESS.md` is the acceptance ledger: what is
verified, by which test, what each part is known to get wrong, and what was
spent on model calls.

## Run it

From the repository root:

```sh
bun install
bun run dev --filter=@foundry/typography
```

Or from `apps/typography`: `bun run dev`. The first run prepares the font
engine in `public/engine` (the Pyodide runtime from `node_modules`, plus the
fontTools and Brotli wheels, downloaded once and checked against the checksums
in Pyodide's lock file).

The Import place offers five sample fonts, so nothing else is needed to try it.

## The places

| Place | What you do there |
| --- | --- |
| Import | Bring in TTF and OTF files, or load the samples. |
| Library | Read a face's names, metrics, axes and features, set a specimen, export the original file unchanged. |
| Coverage | Browse Unicode by script and block, search characters, inspect one, read coverage by script and language. |
| Studio | Edit a glyph's outline and metrics, see the change in text at once, compare with the source, step through revisions, pin a variable face. |
| Generate | Draw missing characters by rule, from a recorded model run, or with a model and your own key. Extend a face with a defined script subset. Generate the same characters across the weights of a variable face. |
| Reconstruct | Recover letters from a photograph, see each outline over the picture with its fit, and infer the letters the picture does not show. |
| Proof | Set text in a built font's real bytes beside the source, and compare shaping and pixels. |
| Export | Choose faces, characters, features, format and name, build, read the checks, download. Rebuild pinned instances into one variable font. |

Three rules hold in every place. Source fonts and photographs are never
changed. Generated and reconstructed glyphs arrive as candidates and enter a
face only when you accept them. The interface says where a glyph came from: ink
is the source font, solid blue is work that is in the face, dotted blue is
generated or inferred work not yet accepted, blue corner brackets are letters
traced from a photograph and not yet accepted, and a crossed box is a missing
character.

## What it does not do

- It does not call a model unless you paste a fal key into Generate or
  Reconstruct. The key is held in memory. The vector model fetches its
  reference sheet by address, so the app puts that sheet on fal's storage,
  where it is asked to expire after an hour. The recorded runs under
  `test/fixtures/generation` are real model output saved earlier, and every
  screen labels a replay as recorded, not live.
- The Devanagari work is a defined subset: 15 characters, 3 forms and 9 test
  words. It is not support for Devanagari or for any language.
- Reconstruction works on clear, flat lettering. Of the three sample
  photographs, the storefront banner works, and the copper letters and the
  handwriting do not. Tests pin both failures.
- Generation across weights works on the weight axis only.

## Check it

Run these from `apps/typography`.

| Command | What it does | Needs |
| --- | --- | --- |
| `bun run test` | Unit and engine tests | Nothing after the engine wheels are cached |
| `bun run test:integration` | Independent font validation, and end-to-end tests that drive the app in Chrome | `uv` and Google Chrome |
| `bun run typecheck` | TypeScript | |
| `bun run build` | Production build into `dist` | |

`bun run validate` at the repository root runs lint, dependency, type and
dead-code checks for the whole workspace.

## Scripts

Run these from `apps/typography`. None of them calls a model, except the flow capture when it is given `--live`.

| Command | What it does |
| --- | --- |
| `bun scripts/capture-flows.ts [--only <flow>[,<flow>]] [--live]` | Drives the app in Chrome through its fourteen user flows and writes captioned screenshots with a page to browse them, `.cache/flows/index.html`. A run retakes the flows it ran and keeps the rest. Three flows call a model for real: they run only with `--live`, cost money, and need `FAL_API_KEY`, so run them from the repository root as `bun run env:run -- bun --cwd apps/typography scripts/capture-flows.ts --live`. `bun run clean` deletes the gallery, paid flows included. |
| `bun scripts/tour.ts [--theme black]` | Loads the sample fonts and photographs every place at 1440 and 390 wide into `.cache/shots/tour`. |
| `bun scripts/generation/run-recorded.ts <run directory> <font file>` | Replays a recorded run through the pipeline and prints each candidate's verdict and its agreement with the font's own glyph. |
| `bun scripts/generation/extend-script.ts <font file> <run directory> <output directory>` | Builds the script extension from a recorded run and writes the derived font, a verification report and a proof sheet. Exits non-zero if a check fails. |
| `bun scripts/reconstruction/run.ts <image> <region> <output directory> [fonts...]` | Reconstructs the lettering in one region of a photograph and writes a report, the isolated lettering and an overlay. |
| `bun scripts/build-unicode-data.ts` | Regenerates `src/unicode/data` from the Unicode and CLDR packages. |

To validate a font file outside the app, with native fontTools and the
OpenType Sanitizer:

```sh
uv run --no-project --with fonttools --with opentype-sanitizer \
  python -I scripts/validate-font.py path/to/font.ttf
```

## How it is built

Two engines sit behind ports, and nothing else imports them.

- **HarfBuzz** (`harfbuzzjs`) reads fonts and shapes text: `src/engines/harfbuzz`
  implements the reading port in `src/typeface/reading.ts`.
- **fontTools on Pyodide** builds fonts in a worker: `src/packaging/engine`
  implements the building port in `src/packaging/building.ts`.

Source fonts are kept byte for byte. Every edit is a change in a revision, so
undo is moving the head. A model provider implements a generation strategy, and
a recorded run is another strategy that replays saved output through the same
pipeline, so swapping a model in or out touches one adapter.

## Test assets

`test/fixtures/fonts` holds openly licensed fonts, each with its licence text.
`test/fixtures/generation` holds real model output, saved as recorded runs with
the prompts and settings that produced it. `test/fixtures/evidence` holds three
photographs free of copyright restrictions. The app can open all three kinds as
samples.
