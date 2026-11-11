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
| Application | One open project and everything that can be done to it with no screen: the workspace, the use cases of each place, the commands, save and close. |
| Command | One thing the application does: import, inspect, generate, reconstruct, accept, export or render. It runs the same use case its place's screen runs and answers in plain data. |
| Refusal | What a command throws when it will not do what it was asked: one plain sentence, or a few, naming the problem and the way out. |
| Means | What an application is opened with: the reader, the builder, the image codec, the artifact manager, the clock, the timer, the id source and the recorded runs served with the app. Chosen in one place and nowhere else. |
| Artifact | A stored thing from `@foundry/artifacts` with a stable id, whose versions are its Contents. The app keeps its files in artifacts. |
| Photograph | An imported image, kept with the project. It becomes evidence when a reconstruction reads it. |
| Model output | What a model returned for one run, kept as the files of a recorded run so it can be replayed. |
| Waiting run | A run whose glyphs go into a face together or not at all, kept until it is accepted. A script extension is one: its layout rules name every glyph. |
| Project file | `project.json`: everything in a project but file bytes, with source fonts and photographs named by artifact id. |

## Marks in the interface

Ink is the source font. Carbon blue is anything made after it. A solid blue
frame is work that is in the face: an edit by hand, or a candidate that was
accepted. A dotted blue frame is generated or inferred work not yet accepted.
Blue corner brackets are lettering traced from evidence and not yet accepted.
A crossed box is a missing character. The words beside a mark always say where
the design came from, accepted or not. These marks come from provenance and
coverage (`designMark` and `designFrame` in `src/typeface/provenance.ts`),
never from ad hoc flags. The words come from there too: `describeProvenance`
says where a design came from, `designOrigin` names it in one word, and
`makingOf` says whether a run was recorded, drawn by a model or built by
rule. A recorded run is always called recorded.

## Contexts

| Directory | Owns | May import |
| --- | --- | --- |
| `src/lib` | Small helpers that know nothing of typefaces: a count with its noun, the reason in a thrown value, a store that can be watched, a code point in writing. | nothing |
| `src/typeface` | The core model: outlines and their geometry, faces, glyphs, changes, revisions, candidates, provenance and its words, the project aggregate, the reading port. Pure TypeScript. | `lib` |
| `src/unicode` | Scripts, blocks, character names, search, coverage, and reading the characters a person typed. | `lib`, `typeface` |
| `src/engines/harfbuzz` | The reading and shaping adapter. The only code that imports HarfBuzz. | `typeface` |
| `src/packaging` | The building port, export plans, subsetting, validation, and the fontTools engine. The only code that imports Pyodide. | `typeface`, `unicode` |
| `src/generation` | The generation pipeline, strategies, evaluation. | `typeface`, `unicode` |
| `src/reconstruction` | Evidence, lettering isolation, recognition, tracing, matching. | `typeface`, `unicode`, `generation` |
| `src/workspace` | Application state: the open project, imported files, open faces, browser font loading. | all of the above |
| `src/ui` | The design system: tokens, symbols, marks, controls. No domain logic. | `lib` |
| `src/import`, `src/library`, `src/explorer`, `src/studio`, `src/generate`, `src/reconstruct`, `src/proof`, `src/export` | The screens, one directory per place in the app. A screen is a default export taking `{ path }`, the address segments below its place. The Coverage place lives in `src/explorer`, because the repository ignores every directory named `coverage`. A place's session is a plain module that is given its means; it never makes itself. | `workspace`, `ui`, domain contexts, `application/react` and the types of the application interface, another place's address module (such as `studio/studio-address`) to link to it, and the two sets of modules named under "What crosses between places" |
| `src/application` | The application interface: the means, the commands, each place's sessions, the project file, and how the app's things are kept as artifacts. `node.ts` is the composition for Node. `react.tsx` hands the open application to the screens. | `workspace`, the domain contexts, the plain modules and sessions of the places (never a component or a hook), and `@foundry/artifacts`. Never `src/app`. |
| `src/app` | The shell: navigation, layout, and the one place the browser chooses its means and opens the application. | everything |

Every directory may import `src/lib`. Every directory but `src/lib`,
`src/typeface` and `src/ui` may also import the digest and the encoding of
the `@foundry/lib` package, which is where a SHA-256 and base64 come from.

### What crosses between places

A place imports another place's address module to link to it. Beyond that,
two things cross, and nothing else does.

The places that show a face share the pieces of `src/library` that do so, so
a face is opened, picked, drawn and counted the same way everywhere:

| To | Modules in `src/library` |
| --- | --- |
| Open a face | `use-face` (the open project, the chosen face and its coverage) and `no-fonts` (what a place says while the project has no face) |
| Pick a face | `face-select` and `face-names` (the label a face carries in a picker and beside it) |
| Draw an outline | `outline-drawing` |
| Show font status | `font-status` (whether the browser has loaded the face's own font) |
| List coverage composition | `composition`, `composition-panel` and `face-coverage` |

Proof is downstream of Export: it proves the derived fonts Export built, so
it reads them where Export keeps them. From `src/export` it may import the
build session (`session`, and `use-export`, the hooks that read it), the
results of a build (`build-run`, `shaping-samples`, `results-section` and
`outcome-tag`) and the face facts (`face-facts`). Export imports nothing from
Proof but its address module.

### The application interface

`src/application/application.ts` exports `Application` and `openApplication`.
`ApplicationMeans` (`means.ts`) is the only place a reader, a builder, an image
codec, an artifact manager, a clock, a timer and an id source are supplied.
The clock says when something happened, as a `Date`. The timer says how long
a step took, in milliseconds. A session is given its clock, its timer and its
ids when it is made and has no default of its own, and neither has a domain
function: a run, a strategy and a revision take the time and the ids they
are given.

The builder an application hands out stamps every build with the clock's time
(`stamping.ts`), so no caller has to. The builder and the reader reach a
screen through the application only: a session is given them when it is
made, proving a font goes through `places.proof`, and the Studio asks
`places.studio` for a font's layout. `workspace/services` holds what only a
browser has: the imported fonts as CSS families, and how the engine is
starting.

`places.providerKey` holds the model provider's key once, for every place
that calls a model. It starts as the key in the means, a person can type
another in any of those places, and a strategy reads it when it runs.

The screens and the commands run on the same application. `src/app/root.tsx`
opens one with the browser's means: artifacts kept in memory, the font engine's
client, HarfBuzz, the browser's image codec, the system clock, random ids and
the recorded runs served with the app. A screen reaches it with
`useApplication` (`application/react.tsx`). `node.ts` opens one for the command
line and the Node tests.

`places.ts` is the only module that makes a place's session, the export
sessions and the working builds of Proof. A command drives its place's own
session, so generation, reconstruction and export are orchestrated once. A
session lists its recorded runs once and keeps what it has read, and a screen
is taken down whenever a person looks at another place. So `places.screen`
holds one session of each place for as long as the application is open, and a
command is given a session of its own for the recorded run it names. The
export session, the variable font session and the working builds are one each
for the open project.

A screen action that is the same act as a command calls the command: the
Import screen imports through `import`, so its fonts are artifacts. Where a
screen needs finer steps than a command offers, such as progress, stopping, a
draft or the browser's check of a font, it drives the place's session.

Only `src/application/node.ts` may import Node modules,
`@foundry/artifacts/node`, `packaging/engine/node` and
`generation/node-image-codec`. Nothing reachable from `src/main.tsx` may import
any of them. `test/application/browser-boundary.test.ts` checks this.

| Thing | Artifact |
| --- | --- |
| An imported font file | One artifact, named by the file's digest, its bytes as frozen Content. The same file twice is one artifact. |
| An imported photograph | One artifact, named by the file's digest, frozen. |
| Model output | One frozen artifact holding `run.json` and its files in the recorded-run format. A waiting run's also holds `change-set.json`. |
| An exported font | One artifact for each exported file name. Every export is a new frozen Content holding the font and `checks.json`, so its Contents are its versions. |
| The project | One artifact holding `project.json`, written in place by `save()`. Its history is the project's own revisions. |

In the browser the artifacts are kept in memory and last as long as the page.

The digest that identifies a source font stays its identity inside the project.
A project opens exactly as it was saved: revisions, candidates, pinned
instances, ids and times. Nothing is replayed.

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
- A check that did not run says `not-run`, never `pass`. Without a browser the
  browser's check of an exported font does not run.
- A build that is given its modified time gives the same bytes every time. The
  application always gives its own clock's time.
- A script is not called supported because its basic characters exist. Say
  which characters and which shaping behaviour were verified.
- Tests live in `test/`, mirror `src/`, and run with `vitest run`. A test
  that follows one path through several contexts, from a font file to a built
  font, lives in `test/across-contexts`. Tests that need the network or
  native tools stay out of the default `test` script.
