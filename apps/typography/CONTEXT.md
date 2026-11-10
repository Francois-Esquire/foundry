# Typography: language and boundaries

The shared vocabulary for this app. Code, tests and interface copy use these
words with these meanings. If a concept is hard to name, fix the model first.

## Language

| Term | Meaning |
| --- | --- |
| Typeface Project | The workspace. Holds source fonts, faces, revisions and candidates. One aggregate, changed only through the functions in `src/typeface`. |
| Source font | An imported font file, kept byte for byte and identified by its SHA-256 digest. Never modified. Exported as is. |
| Family | Faces that share a family name. |
| Face | One style of a family, read from one source font. Static, variable, or a pinned instance. |
| Variable face | A face with variation axes. It can be inspected and set in specimens, not edited. |
| Pinned instance | One axis location of a variable face, turned into an editable face. |
| Character | A Unicode code point. Identity is the code point, never a glyph. |
| Glyph | A drawn shape in a face. A source glyph is named by its glyph id. An added glyph is named by a key and a glyph name. |
| Character map | Which glyph a character maps to before shaping. Several characters can share a glyph. A glyph can have no character at all: ligatures, conjuncts and alternates are reached only through shaping. |
| Outline | Glyph geometry: closed contours of line, quadratic and cubic segments, in font units with y up. Direction is free; the build engine normalises it. |
| Advance | How far the pen moves after a glyph. Bearings are derived from the advance and the outline bounds. |
| Shaping | Turning text into positioned glyphs with the face's layout rules. Always done by HarfBuzz. |
| Layout feature | A named set of OpenType substitution or positioning rules, such as `liga` or `akhn`. |
| Change | One difference from the source: outline replaced, advance changed, glyph added or removed, features added. |
| Revision | A labelled group of changes. Revisions are ordered, and the head says how many are applied. |
| Working face | A face's applied changes folded into one view: overrides, added glyphs, new character mappings, feature code. |
| Candidate | A proposed glyph design with provenance. It stays out of the face until accepted. Accepting it creates a revision. |
| Provenance | Where a design came from: manual, generated (strategy, model, run), or reconstructed (evidence, observed or inferred). |
| Evidence | An imported image that lettering is reconstructed from. Kept untouched, like a source font. |
| Observed / inferred | Observed lettering was seen in the evidence. Inferred lettering was not, and is always marked. |
| Coverage | For a face and a script or block: which characters are in the source, edited, candidates, or missing. |
| Derived font | A font file built from a source font plus a working face. Renamed so it never passes for the original. |
| Export plan | What to build: faces, characters or scripts, features, format. |
| Generation strategy | One interchangeable way of producing candidates: procedural, image model, vector model, recorded run. |
| Recorded run | Saved real model output with its provenance, replayed without calling the model. Always labelled as recorded. |

## Marks in the interface

Ink is the source font. Carbon blue is anything made after it. A solid blue
frame is a manual edit. A dotted blue frame is generated or inferred and not
yet accepted. A crossed box is a missing character. These marks come from
provenance and coverage, never from ad hoc flags.

## Contexts

| Directory | Owns | May import |
| --- | --- | --- |
| `src/typeface` | The core model: outlines, faces, changes, revisions, candidates, the project aggregate, the reading port. Pure TypeScript. | nothing |
| `src/unicode` | Scripts, blocks, character names, search, coverage. | `typeface` |
| `src/engines/harfbuzz` | The reading and shaping adapter. The only code that imports HarfBuzz. | `typeface` |
| `src/packaging` | The building port, export plans, subsetting, validation, and the fontTools engine. The only code that imports Pyodide. | `typeface`, `unicode` |
| `src/generation` | The generation pipeline, strategies, evaluation. | `typeface`, `unicode` |
| `src/reconstruction` | Evidence, lettering isolation, recognition, tracing, matching. | `typeface`, `unicode`, `generation` |
| `src/workspace` | Application state: the open project, imported files, open faces, browser font loading. | all of the above |
| `src/ui` | The design system: tokens, symbols, marks, controls. No domain logic. | nothing |
| `src/import`, `src/library`, `src/coverage`, `src/studio`, `src/generate`, `src/reconstruct`, `src/proof`, `src/export` | The screens, one directory per place in the app. A screen is a default export taking `{ path }`, the address segments below its place. | `workspace`, `ui`, domain contexts |
| `src/app` | The shell: navigation, layout, and the one place that chooses the engines and starts the session. | everything |

External tools sit behind ports. HarfBuzz reads and shapes (`typeface/reading.ts`).
fontTools, running on Pyodide, builds, subsets, instances and validates
(`packaging/building.ts`). A model provider implements a generation strategy.
None of their types cross into the domain.

## Rules

- Source fonts and evidence are immutable. Nothing writes to their bytes.
- Every edit is a change in a revision. Undo is moving the head.
- Only static faces and pinned instances take changes.
- A candidate carries provenance and enters a face only when accepted.
- Recorded or procedural output is never labelled as live model output.
- A script is not called supported because its basic characters exist. Say
  which characters and which shaping behaviour were verified.
- Tests live in `test/`, mirror `src/`, and run with `vitest run`. Tests that
  need the network or native tools stay out of the default `test` script.
