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
| Operation | One step of a place's work, as a plain function: it takes what it needs, answers with data, and remembers nothing. Preparing, performing and proposing a run are three. A screen's session and a command call the same ones. |
| Command | One thing the application does: import, inspect, generate, reconstruct, accept, export or render. It is its place's operations in order, and it answers in plain data. |
| Session | What a screen keeps of a place while the application is open: drafts, selection, progress to show, the way to stop. Each of its steps is one operation, shown as busy, then done or failed. |
| Refusal | What an operation throws when it will not go on, and what a command passes to whoever called it: one plain sentence, or a few, naming the problem and the way out. The screen shows the same sentence. |
| Recorded-run source | Where recorded runs are read from: it names the runs it holds and hands over one file at a time. The app's served runs are one, and a run held whole in memory is another. |
| Means | What an application is opened with: the reader, the builder, the image codec, the artifact manager, the clock, the timer, the id source, the recorded runs served with the app, and the way to the recorded run kept at a location. Chosen in one place and nowhere else. |
| Artifact | A stored thing from `@foundry/artifacts` with a stable id, whose versions are its Contents. The app keeps its files in artifacts. |
| Photograph | An imported image the project lists, by its digest and file name, however it arrived: imported by command or opened on the Reconstruct place. Its file is an artifact named from the digest. It becomes evidence when a reconstruction reads it. |
| Model output | What a model returned for one run, kept as the files of a recorded run so it can be replayed. A replay keeps every file the recorded run's manifest names. A screen's session and a command keep it through the same operation, so the same run leaves the same artifact. |
| Verdict | What a run found of a candidate it made: pass, review or fail. The candidate carries it. |
| Held run | A run whose glyphs go into a face together or not at all, held in the project with its changes from when it is made. A script extension is one: its layout rules name every glyph. The project is the one place its changes are stored. |
| Waiting run | A held run no applied revision has accepted. This is read from the history and never stored, so undoing the revision that accepted a run makes it wait again. |
| Project file | `project.json`: everything in a project but file bytes, with source fonts and photographs named by artifact id. Format 2 is written. Format 1 kept verdicts and waiting runs beside the project, and is read by moving each to its owner. |

## Marks in the interface

Ink is the source font. Carbon blue is anything made after it. A solid blue
frame is work that is in the face: an edit by hand, or a candidate that was
accepted. A dotted blue frame is generated or inferred work not yet accepted.
Blue corner brackets are lettering traced from evidence and not yet accepted.
A crossed box is a missing character. The words beside a mark always say where
the design came from, accepted or not. These marks come from provenance and
coverage (`designMark` and `designFrame` in `src/typeface/provenance.ts`),
never from ad hoc flags. The words come from there too: `describeProvenance`
says where a design came from, `designOrigin` names it in one word,
`standingOf` gives the mark and the sentence for where it stands (proposed,
added to the face, or a source glyph edited since), and `makingOf` says
whether a run was recorded, drawn by a model or built by rule. A recorded
run is always called recorded. Every place says the same sentence for the
same standing, because none writes its own.

## Contexts

| Directory | Owns | May import |
| --- | --- | --- |
| `src/lib` | Small helpers that know nothing of typefaces: a count with its noun, the reason in a thrown value, what an operation refuses with, a store that can be watched, a code point in writing, and the newest answer to a request that is asked again as its key changes (`useSettled`, a React hook). | nothing |
| `src/typeface` | The core model: outlines and their geometry, faces, glyphs, changes, revisions, candidates, provenance and its words, layout features (their registered names, which ones a shaper applies unasked, a set of them switched on and off), the project aggregate, the reading port. Pure TypeScript. | `lib` |
| `src/unicode` | Scripts, blocks, character names, search, coverage, reading the characters a person typed, which characters draw nothing, and splitting a text into what a font can set and the characters it lacks. | `lib`, `typeface` |
| `src/engines/harfbuzz` | The reading and shaping adapter. The only code that imports HarfBuzz. | `typeface` |
| `src/packaging` | The building port, export plans, subsetting, validation, and the fontTools engine. The only code that imports Pyodide. | `typeface`, `unicode` |
| `src/generation` | The generation pipeline, strategies, evaluation. | `typeface`, `unicode` |
| `src/reconstruction` | Evidence, lettering isolation, recognition, tracing, matching. | `typeface`, `unicode`, `generation` |
| `src/workspace` | Application state: the open project, the active face, imported files, open faces, browser font loading, and the hooks a screen reads the project and the active face with (`react`). | all of the above |
| `src/ui` | The design system: tokens, symbols, marks, controls, and text set in one font with the crossed box for each character it is told the font lacks. No domain logic. | `lib` |
| `src/import`, `src/library`, `src/explorer`, `src/studio`, `src/generate`, `src/reconstruct`, `src/proof`, `src/export` | The screens, one directory per place in the app. A screen is a default export taking `{ path }`, the address segments below its place. The Coverage place lives in `src/explorer`, because the repository ignores every directory named `coverage`. A place's operations and its session are plain modules that are given their means; a session never makes itself, and an operation imports no session and no React. | `workspace`, `ui`, domain contexts, `application/react` and the types of the application interface, another place's address module (such as `studio/studio-address`) to link to it, and the two sets of modules named under "What crosses between places" |
| `src/application` | The application interface: the means, the commands, what the screens are kept, the project file, and how the app's things are kept as artifacts. `node.ts` is the composition for Node. `react.tsx` hands the open application to the screens. | `workspace`, the domain contexts, the plain modules of the places (never a component or a hook), and `@foundry/artifacts`. Only `places.ts` imports a place's session. Never `src/app`. |
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
| Open a face | `use-face` (what a face covers, and the language data: loading, loaded or not to be had) and `no-fonts` (what a place says while the project has no face). The open project and the active face are read from `workspace/react`. |
| Pick a face | `face-select` and `face-names` (the label a face carries in a picker and beside it) |
| Draw an outline | `outline-drawing` |
| Set a location | `axis-controls` (the instances a variable face's font names and a slider for each axis, stepped to the axis, with a stop at each named instance) |
| Name and link a candidate | `candidate-name` (what Generate and Family call a glyph in a control) and `candidate-link` (the Studio address of an accepted candidate). Each place keeps its own words for where a candidate stands and where it came from, because the words differ. |
| Show font status | `font-status` (whether the browser has loaded the face's own font) |
| List coverage composition | `composition`, `composition-panel` and `face-coverage` |

Proof is downstream of Export: it proves the derived fonts Export built, so
it reads them where Export keeps them. From `src/export` it may import the
build session (`session`, and `use-export`, the hook that reads it), the
results of a build (`build-run`, `shaping-samples`, `results-section` and
`outcome-tag`) and the face facts (`face-facts`). Export imports nothing from
Proof but its address module.

What Generate, Family and Reconstruct share to make and accept candidates
does not cross between them, because it lives below them:

- The strategy offering is in `generation/strategies/offering`. Each place
  gives it its own order and summaries.
- What a run is made with (`run-means`), accepting several candidates at once
  (`accept-candidates`), redrawing a character the project already added
  (`redraw-added`) and the candidates' standings (`react`) are in
  `src/workspace`.
- The provider key and the hint beside its field are in `application/react`.

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
made, proving a font goes through `places.proof`, and the Studio's layout
panel asks `places.layoutSummary` for a loader of its own. `workspace/services`
holds what only a browser has: the imported fonts as CSS families, and how the
engine is starting.

`places.providerKey` holds the model provider's key once, for every place
that calls a model. It starts as the key in the means, a person can type
another in any of those places, and a strategy reads it when it runs.

The screens and the commands run on the same application. `src/app/root.tsx`
opens one with the browser's means: artifacts kept in memory, the font engine's
client, HarfBuzz, the browser's image codec, the system clock, random ids and
the recorded runs served with the app. A screen reaches it with
`useApplication` (`application/react.tsx`). `node.ts` opens one for the command
line and the Node tests.

A place's work is a set of operations: plain functions in the place's own
directory that take what they need, answer with data and throw a `Refusal`
when they will not go on. Generate prepares a run, performs it, keeps what a
model returned and proposes its candidates (`generate/running.ts`). The
script extension finds its sheets, extends a face and holds the result in the
project as a run (`generate/script-extension/extending.ts`). Reconstruct
keeps a photograph, reads the letters of a region, proposes them, completes
the alphabet and proposes what was inferred (`reconstruct/reading.ts`,
`proposing.ts`, `completing.ts`). Export resolves a draft and runs its builds.

A screen's session and a command call the same operations, so each use case
is written once. A session step is one operation between two states: busy,
then done with the result or failed with the refusal's sentence. A command is
the operations in order and a mapping of their results. It makes no session
and reads no session's state. Whatever stops generate or reconstruct, an
operation's refusal or a failure beneath it, leaves the command as a refusal
(`application.ts`), as it leaves a session as the sentence it shows. So what
a command refuses with is the sentence the screen shows. `test/application/equivalence.test.ts` holds that, and
that a screen and a command leave the same project.

Recorded runs come from a recorded-run source
(`generation/strategies/recorded/source.ts`), and one catalogue lists and
loads them for every place (`catalogue.ts`). A screen's sessions are given
the runs served with the app. A command is given the run kept at the
location it names. Either way the files kept as model output are the ones
the run's manifest names (`recordedFiles`), which is what makes a screen's
artifact and a command's the same one.

`places.ts` holds what the application keeps for its screens, and is the
only module that makes a session. It has one rule. A screen is taken down
whenever a person looks at another place, so `places.screen` holds one
session of each place for as long as the application is open. And the open
project has one of each thing its places share: the export session, the
variable font session, the working builds of Proof and the provider key.
`test/application/use-case-boundary.test.ts` checks these boundaries.

A screen action that is the same act as a command calls the command: the
Import screen imports through `import`, so its fonts are artifacts. Where a
screen needs finer steps than a command offers, such as progress, stopping, a
draft or the browser's check of a font, it calls its place's session, which
calls the same operations one at a time.

Only `src/application/node.ts` may import Node modules,
`@foundry/artifacts/node`, `packaging/engine/node` and
`generation/node-image-codec`. Nothing reachable from `src/main.tsx` may import
any of them. `test/application/browser-boundary.test.ts` checks this.

| Thing | Artifact |
| --- | --- |
| An imported font file | One artifact, named by the file's digest, its bytes as frozen Content. The same file twice is one artifact. |
| An imported photograph | One artifact, named by the file's digest, frozen. |
| Model output | One frozen artifact holding `run.json` and its files in the recorded-run format, and nothing else. A project saved in format 1 kept a waiting run's `change-set.json` there, which is read once, when that project is opened. |
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
- Whenever the project has a face, one of them is the active face. The
  workspace keeps this when it opens a project, imports and removes a font,
  so a place reads the active face and has no fallback of its own.
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
