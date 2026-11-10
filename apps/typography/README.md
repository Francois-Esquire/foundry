# Typography

A creative typography studio that runs in the browser. Import a typeface,
explore what it covers across the world's writing systems, edit glyphs, generate
or reconstruct the ones it lacks, and export a derived font. Everything stays in
memory and no font leaves the machine.

`CONTEXT.md` defines the vocabulary and the directory boundaries. `DESIGN.md`
records the design system. `PROGRESS.md` is the acceptance ledger: what is
verified, by which test, and what is not done.

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

## Check it

Run these from `apps/typography`.

| Command | What it does | Needs |
| --- | --- | --- |
| `bun run test` | Unit and engine tests | Nothing after the engine wheels are cached |
| `bun run test:integration` | Independent font validation and end-to-end tests in Chrome | `uv` and Google Chrome |
| `bun run typecheck` | TypeScript | |
| `bun run build` | Production build into `dist` | |

`bun run validate` at the repository root runs lint, dependency, type and
dead-code checks for the whole workspace.

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
undo is moving the head. Generated and reconstructed glyphs are candidates with
provenance and enter a face only when accepted.

## Test assets

`test/fixtures/fonts` holds openly licensed fonts, each with its licence text.
`test/fixtures/generation` holds real model output, saved as recorded runs with
the prompts and settings that produced it. `test/fixtures/evidence` holds two
photographs free of copyright restrictions. The app can open all three as
samples.
