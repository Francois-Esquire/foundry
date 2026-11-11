# Progress

The acceptance ledger for the typography studio. One row per criterion in the
brief, with the test or script that proves it. Updated at each milestone.

Status words: done (verified by the named evidence), partial, not started,
unavailable (blocked by something outside the repo, with the reason).

## State on 11 November 2026: one interface, artifacts, and a quality review

The app can now be driven without a browser, its project survives being
closed, and it stores what it handles in this repository's own artifact
package. A strict quality review then went over the whole branch. The work
passes every check and is **not approved by that review's standard**: the open
findings are listed below with their remedies.

### What was added

- **One application interface** (`src/application`). `openApplication` opens a
  project and offers `import`, `inspect`, `generate`, `reconstruct`, `accept`,
  `export` and `render`, with `save()` and `close()`. It is the only place a
  reader, builder, image codec, clock and id source are chosen. The React root
  opens the same application the command line and the Node tests open.
- **Artifacts** (`@foundry/artifacts`, wired as Marbles wires it). An imported
  font, a photograph, a model's output and an exported font are each an
  artifact. Each export is a new frozen Content of its artifact, so an export
  has versions. The project is an artifact holding `project.json`, and it
  reopens exactly as saved.
- **A command line** (`bun scripts/typography.ts <command> --project <dir>`),
  one process a command. See the README.
- **Repeatable builds.** A build takes the time to stamp. The same project and
  clock give the same bytes.

Not adopted, with the reason:

- `@foundry/workflows`. Approval already waits durably, as candidates and
  waiting runs in the saved project. A workflow run would be a second record
  of the same wait.
- `@foundry/models/fal`. It exists, with the official fal client, its file
  upload and image models. An earlier note by the orchestrator said the models
  package covered language models only. That was wrong. Its client goes
  through fal's queue host, its catalogue lists neither of this app's two
  models, and the flow capture's spending guard and every network stand-in
  assume the direct host, so the swap is not a small change. It is the first
  open reuse finding. No live call was spent on it: 5 of 6 remain used.

### Commits

| Commit | What |
| --- | --- |
| `26b0d1ff` | The interface, artifacts, the command line, and the journey test that defines them |
| `6137a1ff` | Six duplications removed in packaging and generation |
| `bb3abab2` | The screens run on the interface; the proof build leaves its hook |
| `530277b8` | The bounded fixes from both reviews |

### Checks, run by the orchestrator on the final tree

| Check | Result |
| --- | --- |
| `bun run validate` at the root | exit 0 |
| Unit tests | 1478 passed in 178 files |
| Integration and Chrome tests | 84 passed in 16 files |
| Production build | exit 0, no Node-only code in the browser bundle |
| The built app, walked in Chrome | every place renders, no console errors, the engine builds a font |
| The command line, by hand | import, generate, accept, export and render as separate processes |
| Largest hand-written file | `engine.py`, 955 lines. None reaches 1000 |

The main browser chunk grew from 261 kB to 388 kB: the artifacts package and
its validation library now ship to the browser.

### The quality review

Standard: `.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`. Base:
`main` at `99e22579`, against which everything under `apps/typography` is new.
Left out: `test/fixtures`, the generated `src/unicode/data`, `bun.lock`. Two
independent reviewers (Opus) read the code. Their full findings, with files,
lines and remedies, are in `.cache/review/thermo-domain.md` and
`.cache/review/thermo-screens.md`, which are not tracked.

Coverage, stated as the reviewers gave it. Read in full: `src/typeface`, the
packaging TypeScript, the HarfBuzz reader, most of `src/workspace`, all of
`src/application`, the command line, the three large sessions, the export
session, the proof build, the root. Sampled: `engine.py`, generation, unicode,
reconstruction, the design system, scripts, tests, parts of the Generate,
Reconstruct and Export screens. **Not read:** `src/studio`, `src/explorer`,
`src/library`, most of `src/import` and `src/proof`, `src/export/variable`,
the Generate and Reconstruct components, parts of generation (`vector/svg`,
`style`, `evaluation`, `normalise`) and of reconstruction (`recognition`,
`recovery`, `inference`, `report`). Nothing is claimed about those.

Fixed: domain findings 2, 3, 5, 6, 7, 10, 11 and 14, with 12 and 15 in part
(three curve evaluators with different arithmetic remain, and so do some
repeated test fixtures); screens findings 4, 5, 8, 9, 10 and 12, with 11 in
part (the store still writes its own tree digest, because the package's gives
a different answer, and its get-then-create can race); and what the
orchestrator's own scan found
(one counter of words where 22 files had one, one error reason where 10 had
one, one store helper where 11 were written by hand, one function that puts
provenance into words, the 1215-line workflow test split into five files).

**Open, and blocking approval.** Each is a redesign, not a bounded fix:

| Finding | Remedy |
| --- | --- |
| ~~The commands drive the screens' sessions step by step and read state back to learn what happened~~ | Closed in `699db6fb`: each place exports plain operations that its session and its command both call. Net code stayed flat, and no reviewer has read the result yet |
| ~~Recorded runs reach a session through a stand-in web server, and the catalogue loader is written twice~~ | Closed in `699db6fb`: one port for a source of recorded runs, and one catalogue |
| ~~Verdicts and waiting runs live in a record beside the project~~ | Closed by the state-ownership change: a candidate carries its verdict, the project holds its runs with their changes and lists its photographs, and whether a run is waiting is read from the revisions. The saved file is format 2, and a format-1 project is read. No reviewer has read the result yet |
| The script extension commits its glyphs directly and never proposes candidates | Candidates, with one operation that accepts a batch as one revision. Changes the saved format |
| Candidate status is both stored and derived | Derive it. Belongs with the row above |
| Packaging has its own model of a set of characters beside the one in `src/unicode` | Use unicode's. The packaging tests check invented ranges and need rewriting |
| `engine.py` passes internal flags through request data and is 955 lines | Split it by entry point |
| Reconstruction reaches into twenty internal generation modules | A shared imaging context. Needs a new row in `CONTEXT.md` |
| The app's fal transport stands beside `@foundry/models/fal` | Swap the transport, with live calls to verify it |

Open, smaller: six glyph drawing components across the screens; price tables
in more than one place; three curve evaluators with different arithmetic;
a run across weights made on screen does not keep its model output; nothing
rejects a candidate by command or discards a waiting run, so every replay of
the script extension leaves a run in the project; removing a font drops the
runs held for it without saying so; two processes on one project directory
can lose each other's changes to `project.json`.

Decisions waiting for the owner:

- Whether to do the redesigns above before this lands.
- The words for observed lettering. Coverage said "seen in the evidence" and
  the Studio said "observed in the evidence". One function now says it, with
  the Studio's words.
- What happens to an earlier waiting run when a later one is made for the
  same face and script, or when one of them is accepted. Today both stay
  listed, and the one left can never be accepted.
- What the generate command's `runId` means for a run of candidates. Today it
  is a fresh id that nothing takes back.

The last commit of fixes, `530277b8`, changed 258 files after both reviewers
had finished. No reviewer read it. The orchestrator read what it introduced
(`src/lib`, `application/stamping.ts`, `places.ts`, `workspace.pinAndPropose`)
and verified the rest by the checks above only. What that reading found:
`src/lib` and the stamping wrapper are small and direct, and `pinAndPropose`
is one change or none. `places.ts` did not get simpler. It still holds three
kinds of lifetime (a screen's kept session, a command's fresh one, and shared
single sessions), and it gained two members, one of them a pass-through to
the builder for the Studio. That is the first open finding, unchanged.

Choices in this pass that a caller can see, made without asking the owner:
the clock is `() => Date` everywhere and the Node option `now` became `clock`
(the journey test's helper changed with it); `Places.studio`,
`Places.providerKey` and `workspace.pinAndPropose` are new; `acceptCandidate`
takes a time and an id, as `commit` does.

Tests that got weaker or changed what they assert: the check that every link
in the app goes somewhere pooled links across four workflows with a floor of
20, and now checks each workflow alone with a floor of 8. One Coverage
assertion on the words for observed lettering was removed when the wording
was unified, and the words shown in Coverage's inspector and in Proof's
"Origin" changed with it. Two Import screen assertions now wait, because a
font is kept as an artifact before the summary appears.

Both review files are under `.cache`, which `bun run clean` deletes and which
goes with the worktree. This section is the durable record of them.

Delegates in this pass, under the owner's standing go-ahead for subagents: two
builders and two fixers on Fable 5.2, and two reviewers on Opus 5.5. The
orchestrator ran the checks itself on each one's work before committing it.

Also checked on the final tree: Chrome tests pass with Vite's dependency
cache removed first, no source file is hidden by an ignore rule, and a frozen
install succeeds. No pull request exists, so no outside reviewer has seen the
branch. How it lands (a pull request, or a local merge) is still undecided.

## State on 10 November 2026

All eight phases meet their acceptance criteria, each inside the limits the
ledger states. The branch is `typography`. It is not pushed and not merged.

The last full run of every check, made by the orchestrator with no other work
running:

| Check | Command | Result |
| --- | --- | --- |
| Lint, format, dependencies, types, dead code | `bun run validate` at the repository root | exit 0. 2766 files checked, 32 type-check tasks, no dead code reported in this app |
| Unit and engine tests | `bun run test` | 1371 passed in 160 files |
| Independent validation and Chrome tests | `bun run test:integration` | 84 passed in 12 files: 25 checks with native fontTools, the OpenType Sanitizer and the engine in Chrome, and 59 end-to-end tests |
| Production build | `bun run build`, then the built app served and walked in Chrome | every place renders, no console errors, and the engine builds a font in the built worker |
| Every place by eye | `bun scripts/tour.ts`, both themes, 1440 and 390 wide | the orchestrator looked at all 32 screenshots as four contact sheets, after looking at each place's own screenshots at full size when it landed |

Licensing, as built: Export refuses a derived font whose family name holds a
name the source's licence reserves, and warns on an unknown licence, restricted
embedding and a reconstruction from a photograph. The script extension's
verification build and `scripts/generation/extend-script.ts` name their font
through the same reading of the licence, so the file the script writes for Lato
is `DevanagariSubset-Regular.ttf`. An earlier version of both used the name
"Lato Devanagari Subset", which Lato's licence does not allow. One build keeps
the source's own name: the working build in Proof. It exists only in memory to
be set beside the source and is never offered as a download.

What needs the owner:

- A choice of quality for the live models. Both run at their lowest quality,
  which is what the first live calls used. See "The app's own model calls".
- A reader of Devanagari and a type designer, to judge the generated letters.
- A decision to push or merge. Neither was done.

Model spending: ten calls, all on 10 November 2026. Five were made through the
orchestrator's tool and recorded as fixtures: one to GPT Image and four to
Ideogram Vector. Five were made by the app itself with the owner's key, under a
limit of six: three succeeded (one GPT Image, two Ideogram Vector) and two were
refused by the provider before it drew anything. No charge is reported for a
call, and both models are priced by a unit whose count for each call is not
published, so no figure is claimed here. The exact charge is on the fal account.

## Decisions

| Decision | Why |
| --- | --- |
| HarfBuzz (`harfbuzzjs` 1.6.4) reads and shapes fonts. | One engine for cmap, outlines, axes and shaping, so inspection and shaping never disagree. Verified in Node and in Chrome. |
| fontTools 4.62.1 on Pyodide 314.0.7 builds fonts, in a worker. | It is the established tool for compiling, merging layout, subsetting and instancing. Cold start is about 1.2 s in Chrome. Runtime and wheels are served from `public/engine`, so fonts never leave the browser. |
| fontkit was tried and dropped. | HarfBuzz covers what it offered, and a second parser could disagree with the shaper. |
| Feature code is grafted onto existing layout tables. | fontTools' feature compiler replaces GSUB and GPOS. The engine compiles into a shadow font and merges lookups, features and scripts, so source shaping survives. |
| Edits to a variable face go through a pinned instance. | Changing one master's outline would break the variation data. |
| One app, `apps/typography`, with a directory per bounded context. | See `CONTEXT.md`. No packages until a second consumer exists. |
| A variable font is rebuilt from pinned-instance masters with fontTools varLib. | In the engine as `FontBuilder.buildVariable`. Three masters of Sofia Sans (954 glyphs) build in about 11 s in the Chrome worker and 13 s in Node. Interpolation between masters is linear: the source's `avar` mapping and intermediate designs are dropped, and the engine says so in its notes. |
| A reconstruction that starts from an image gets a blank source font made by the engine. | The project model stays uniform: every face has a source font, and reconstructed letters arrive as candidates on it. In the engine as `FontBuilder.blankFont`. The same request always gives the same bytes. |
| A model draws vowel signs on a known base letter, and the pipeline separates them. | Asked for Devanagari vowel signs alone, the model attached them to base letters. Asked for syllables on क, it drew all eight correctly. |

## Acceptance ledger

Every test named here was run by the orchestrator after its author finished,
not only by the author. Tests under `test/e2e` drive the real app in Chrome.

| Phase | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Import two fonts with different script coverage, one variable | `test/e2e/library.test.ts` imports the five sample fonts through the Import place, among them Sofia Sans (variable, Latin, Greek, Cyrillic) and Noto Sans Devanagari (variable). `test/engines/harfbuzz-reader.test.ts`, `test/workspace/import.test.ts` | done |
| 1 | Correct coverage | `test/unicode/data.test.ts` (the generated data equals the Unicode 17 package), `test/unicode/coverage.test.ts`, `test/explorer/`, and the Devanagari and U+0915 steps of `test/e2e/library.test.ts` | done |
| 1 | Working specimen controls | `test/e2e/library.test.ts`: the weight slider changes the measured width of text set in the imported font. `test/library/` | done. Feature toggles are tested for state, not for a change in the rendered text |
| 1 | Unchanged original-file export | `test/e2e/library.test.ts` and `test/e2e/studio.test.ts` compare the downloaded file's SHA-256 with the fixture's. `test/across-contexts/spine.test.ts`, `test/workspace/export.test.ts` | done |
| 2 | Edit a glyph or its metrics, preview in text, source preserved | `test/e2e/studio.test.ts`: move a node from the keyboard, set an advance, see the specimen line grow by exactly three advances, undo, and export the untouched original. `test/studio/` (152 tests), `test/across-contexts/edited-curves-to-font.test.ts` | done |
| 3 | Modified font loads independently with intended coverage and shaping | `test/e2e/export.test.ts`: the downloaded subset reopens with exactly the 96 planned characters, still forms `fi`, and native fontTools with the OpenType Sanitizer accept it. `test/integration/packaging/` (25 checks) | done |
| 4 | Real generated candidates, normalised, refined, in a derived font | `test/across-contexts/generation-to-font.test.ts`: the recorded output of two real models becomes six candidates each, one is accepted, edited by hand and built into a font that validates. `test/e2e/generate.test.ts` replays both in Chrome, the raster sheet included, accepts one and opens it in the Studio | done. The fixtures are real model output recorded through the orchestrator's tool. The app's own calls have since run with the owner's key: three live runs in Chrome, photographed in the flow capture. At the lowest quality none of the five live Generate candidates passed evaluation |
| 5 | A defined script extension with functional shaping | `test/generation/script-extension/extension.test.ts` and `test/e2e/script-extension.test.ts`: Lato gains the Devanagari subset from real recorded model output, and in the exported font नमस्ते shapes to the planned glyphs, सितार puts the vowel sign first and `fi` still forms | done for the subset: 15 characters, 3 forms, 9 test words. Not support for Devanagari or any language |
| 6 | Coordinated faces or a valid variable font | `test/e2e/family.test.ts`: six letters generated at three weights of Sofia Sans, exported as three static fonts whose ink grows with weight and as one variable font whose added glyphs interpolate, accepted by the native validator. `test/generation/family/`, `test/integration/packaging/` | done, both ways. Across weights only the procedural strategy has run for real |
| 7 | Usable candidates recovered from a real image, editable | `test/reconstruction/storefront.test.ts` (19 of 19 letters found, fit 0.946 to 0.990) and `test/e2e/reconstruct.test.ts`: mark the banner, correct a label, accept 12 observed letters on a new face, infer 15 more from the recorded run, edit one in the Studio, and the photograph's bytes are unchanged | done for the storefront photograph. The copper letters and the handwriting fail, and tests pin that |
| 8 | Integrated workflows end to end | `test/e2e/workflows/`: four workflows, each from an empty project to a downloaded font that the test reopens and that native fontTools with the OpenType Sanitizer accept. Lato gains the Devanagari subset and exports renamed. The storefront photograph becomes a 28-character face with one letter edited by hand. A pinned Sofia Sans gains 24 Latin letters built by rule and exports as a Latin subset. Sofia Sans gains four letters at three weights and exports as three static fonts and one rebuilt variable font | done. No model is called in any of them |

What only a person can judge, noted here and not treated as blocking:

- Whether the generated Devanagari letters are good letters. They pass identity
  checks against Noto and shape correctly. A reader of the script and a type
  designer have not looked at them. They are measurably lighter than Lato.
- Whether inferred storefront letters suit the observed ones once squeezed to
  width. The measurements say the uprights then match and the level strokes
  stay heavier.
- Whether the interface direction reads as intended in daily use. The
  orchestrator looked at every place at two widths.

## Resource usage

Paid model calls so far: 5, all on 10 November 2026, all successful on the
first attempt. Raw outputs are under `test/fixtures/generation/`.

| Call | Model | Settings | Latency | Charge |
| --- | --- | --- | --- | --- |
| Latin holdout sheet, six glyphs | GPT Image 2.6 Flare Edit | low quality, 1536 by 1024 | 9.9 s | not reported by the tool |
| Latin holdout sheet, six glyphs | Ideogram Vector | medium quality, 3:2 | 19.9 s | not reported by the tool |
| Devanagari letters, sixteen cells | Ideogram Vector | medium quality, 1:1 | about 20 s | not reported by the tool |
| Devanagari syllables, eight cells | Ideogram Vector | medium quality, 2:1 | about 20 s | not reported by the tool |
| Storefront completion, fifteen inferred glyphs | Ideogram Vector | medium quality, 16:10 | about 20 s | not reported by the tool |

What the Devanagari calls showed: ten of sixteen letter cells were right (eight
consonants and vowels, ष and the conjunct क्ष). The model would not draw vowel
signs alone and attached them to a base letter. A second sheet of whole
syllables on the base क came back correct in all eight cells, so the vowel
signs, anusvara, halant and half forms are separated from a known base instead.

What the storefront call showed: given only a crop of the photograph, the model
drew all fifteen requested glyphs as the right characters. It did not match the
banner's letters. Measured by the reconstruction core at the same cap height,
the inferred glyphs are about 2.2 times as wide and their upright strokes about
2.1 times as thick (210 units against 98). The model drew the design at its
natural width. An earlier note here said it had matched the weight. That was
judged by eye and was wrong. The banner's two lines are also set at different
widths, so the thirteen observed letters are not one coherent width either.

The provider's tool returns no per-request charge, so the exact cost is on the
account's fal dashboard, not here. To stay inside the cap without that figure,
GPT Image calls are limited to four in total at low or medium quality.

Spending cap for generation experiments: 5 US dollars in total. The owner asked
for real generation but named no figure, so this cap is self-imposed. The first
call to any model runs once at its lowest quality to measure the real charge
before anything else is sent.

Models found on 10 November 2026 (discovery and price lookups only, no charge):

| Model | Endpoint | Listed price | Role |
| --- | --- | --- | --- |
| GPT Image 2.6 Flare Edit | `openai/gpt-image-2.6/flare/edit` on fal | 1 dollar per unit; units per image are not published | Image strategy: glyph sheet from a style reference |
| Recraft V4.1 text to vector | `fal-ai/recraft/v4.1/text-to-vector` on fal | 0.08 dollars per image | Direct vector strategy |
| Ideogram Vector | `ideogram/vector/text-to-vector` on fal | 0.01 dollars per unit | Direct vector alternative, takes reference images |
| Recraft vectorize | `fal-ai/recraft/vectorize` on fal | 0.01 dollars per image | Remote tracing alternative |
| Image2svg | `fal-ai/image2svg` on fal | 0.005 dollars per image | Remote tracing alternative |
| Arrow 2 (QuiverAI) | `vercel/quiverai/arrow-2` | not published here | Unavailable. Listed as an OpenCode delegate model, but the one attempt on 10 November 2026 was refused: the gateway has no zero-data-retention provider for it. |

fal is connected to the orchestrating agent as a tool. The environment holds no
provider keys, so the app itself cannot call a model until a user supplies one.
The five paid calls above were made through that tool and their raw output was
recorded.

### The app's own model calls

The owner then supplied a fal key in the root `.env` as `FAL_API_KEY`, declared
in `.env.schema` as optional and sensitive. The app does not read it. A person
pastes a key into the masked field in Generate or Reconstruct, and the flow
capture does the same from its own environment. Calls made by the app on 10
November 2026, all in Chrome through `scripts/capture-flows.ts --live`:

| Place | Model | Asked for | Took | Outcome |
| --- | --- | --- | --- | --- |
| Generate | Ideogram Vector, low quality | é è ñ | 1.1 s | refused, HTTP 422 |
| Generate | GPT Image 2.6 Flare Edit, low quality | é è ñ | 14.0 s | two candidates, one cell empty, neither passed evaluation |
| Reconstruct | Ideogram Vector, low quality | B C J | 1.1 s | refused, HTTP 422 |
| Generate | Ideogram Vector, low quality | é è ñ | 17.9 s | three candidates, none passed evaluation |
| Reconstruct | Ideogram Vector, low quality | B C J | 18.4 s | three inferred letters |

What the calls showed:

- The app's vector client was wrong against the real service. It sent the
  reference sheet inside the request, and this model fetches its references by
  address: "Could not download the image". The client now puts the sheet on
  fal's storage first, asks for it to expire after an hour, and sends the key
  to fal's own host only. The strategy's description says so on the screen.
  Whether fal removes the file after that hour was not checked.
  `test/generation/strategies.test.ts` covers the upload and its failures.
  The image client sends its reference inline and works as it was.
- In Generate, the live vector model drew three recognisable letters that are
  heavier and larger than Lato's own, so none passed evaluation. The live image
  model left one of three cells empty. Both ran at their lowest quality. The
  recorded fixtures, made at medium quality, scored far better.
- In Reconstruct, the live vector model was shown the app's own sheet of the
  observed letters and drew B, C and J at 1.03 times the observed width. The
  recorded run, shown a crop of the photograph, drew them at 2.18 times.
- One call of each kind is not a measurement. It shows the path works.

## Delegated work

Task ids share the prefix `node:delegated-task:command%3Amcp%3Aab3e64ef-5269-475a-a872-ae52d8fcf6b0%3Adelegate-task%3A`.
Delegates work in this checkout on disjoint paths and do not commit.

| Wave | Work | Paths | Task id suffix | Status |
| --- | --- | --- | --- | --- |
| 1 | Design system and app shell | `src/ui`, `src/app`, `src/main.tsx`, `index.html`, `DESIGN.md` | `8de13fe5-9fce-4889-94d0-e393b5737a5b` | done, committed |
| 1 | Unicode context | `src/unicode`, `scripts/build-unicode-data.ts` | `f4996cc7-fd95-4a17-8e2b-4401edfdd5e8` | done, committed `7ed547f9` |
| 1 | Workspace state and test fonts | `src/workspace`, `test/fixtures`, `test/helpers` | `ee7ca45a-4bb0-4355-966a-c0dfbd098613` | done, committed `7ed547f9` |
| 1 | Packaging and validation | `src/packaging`, `scripts/validate-font.py` | `b3f670a5-2114-4566-937f-88cb52a3b006` | done, committed |
| 1 | Generation pipeline core | `src/generation`, `scripts/generation` | `c4e86af3-0d6f-4cb8-a6d5-06d70bf9af2f` | done, committed `54d36649`. 90 tests. Weak points it reported are listed below. |
| 1 | Arrow 2 glyph sheet experiment (OpenCode model `vercel/quiverai/arrow-2`) | writes `test/fixtures/generation/2026-11-10-latin-holdout/arrow-2.svg` | `289a1f51-3277-4b9e-8e83-ba7fbdb17eca` | failed: the gateway has no zero-data-retention provider for this model, so it cannot run here. No output, no charge. |
| review | Independent review of the foundation (Opus) | reads `src/typeface`, `src/engines`, `src/unicode`, `src/workspace`; edits nothing | `50603e64-8904-4609-9fb2-03025948ae60` | done: eleven defects found, all fixed with a regression test each, see below |
| 2 | Import, Library and Coverage places | `src/import`, `src/library`, `src/explorer`, `test/e2e/library.test.ts` | `f3c2a089-1d0b-4c33-93ec-a115ec0557ab` | done, committed `a760c0ef`. 114 unit tests, and 9 of 9 end-to-end steps in Chrome after the orchestrator fixed the two blockers it reported. |
| 2 | Studio place | `src/studio`, `test/e2e/studio.test.ts` | `4e899de4-d501-4f11-ad15-8e53f1f90254` | done, committed `19c0b8ec`. 152 unit tests and the acceptance test in Chrome pass. |
| 3 | Export and Proof places | `src/export`, `src/proof`, `test/e2e/export.test.ts` | `4a66cee3-45cd-46db-8b8b-c8bf3f9d0e88` | done, committed. 46 unit tests and 10 checks in Chrome pass, including the native validator accepting the downloaded file. |
| 3 | Family generation and variable fonts | `src/packaging`, `src/generation/family` | `4b7b22c5-18ca-4df3-ac05-4cdfb072ea03` | done, committed `f67de671`. 179 unit tests and 25 integration checks pass. Engine and domain only: no screen called it when it landed. |
| 3 | Reconstruction core | `src/reconstruction`, `scripts/reconstruction` | `51c27c42-497b-4141-a1d5-9c4b2c5c77d1` | done, committed `7083b77d`. 63 tests. The orchestrator looked at the overlay on the photograph and at the recovered letters. |
| 4 | Script-aware generation (Devanagari subset) | `src/generation/script-extension`, `scripts/generation/extend-script.ts` | `de7ffdba-271e-45b1-8c9b-8030b5f63aa4` | done, committed `05282159`. 81 tests. The orchestrator looked at the proof sheet. Domain and script only: no screen called it when it landed. |
| 4 | Generate place | `src/generate`, `test/e2e/generate.test.ts` | `ce5cdda1-c853-4b6b-b5f9-925d305b2b94` | done, committed `957f2719`. 50 unit tests and 4 checks in Chrome pass. |
| 5 | Family generation in Generate and Export | `src/generate/family`, `src/export/variable`, `test/e2e/family.test.ts` | `de4f757b-925b-462f-8f2c-1abb6a646764` | done, committed. 67 unit tests and 11 checks in Chrome pass, including the native validator on the variable font. |
| 5 | Script extension in Generate | `src/generate/script-extension`, `test/e2e/script-extension.test.ts` | `94dd090f-d54f-4e23-bd8d-5de2319e7837` | done, committed. 32 unit tests and 6 steps in Chrome pass. The orchestrator looked at the verification screen. |
| 5 | Reconstruct place | `src/reconstruct`, `test/e2e/reconstruct.test.ts` | `b88ae059-c92c-4767-9114-f45791bef26d` | done, committed `e1617c0f`. 49 unit tests and 2 tests in Chrome pass. Started while the reconstruction core was still in flight, behind one module of its own. |
| 6 | Integrated workflows | `src/app`, `test/e2e/workflows/`, hand-offs in the screens | `34916adc-136b-4b8e-90e9-7bb791f5af58` | done, committed `2c23b1d4`. The orchestrator reran the six workflow tests in Chrome and looked at the screenshots. |
| 7 | Fixes for the review findings | any file a fix needs | `538a7112-c0d9-4c9a-b7cd-056ca45e57ad` | done, committed `5ee50855`. Fifteen items, 63 new unit tests and 6 new tests in Chrome. |
| 8 | Capture of the user flows (GPT 6.1 Sol through Codex, at the owner's request) | `scripts/capture-flows.ts`, `scripts/capture`, `.env.schema` | `1b5d9087-85b2-4a2f-8e0c-41c4023943af`, under the prefix `node:delegated-task:command%3Amcp%3A477e103f-5b5d-4a85-b05c-c6dc5c4cdff8%3Adelegate-task%3A` | done. It wrote the capture, ran it, and made three live calls, of which both vector calls were refused. It changed no app code. The orchestrator then fixed the vector client, reworked the script so a run keeps the flows it did not retake and the three paid flows run only with `--live`, and reran the two vector flows. The gallery is `.cache/flows/index.html`: 14 flows, 117 screenshots. It is not tracked, and `bun run clean` deletes it. |
| review | Independent review of the screens (Opus) | reads the eight places; edits nothing | `ab18545d-f4b4-4abb-9cbf-9627817b5911` | done: twelve findings, see below. It ran every place in Chrome except family generation and the script extension, which it read, and the variable export, which it did not cover. |

Briefs are in `.cache/briefs/` (not tracked): `common.md` holds the rules every
engineer follows, and each delegate reads it with its own brief.

What the Library delegate reported, and what was done about it:

- A directory named `coverage` is ignored by git, the linter and Knip across the
  repository. The Coverage place now lives in `src/explorer`.
- The app root stopped following imported fonts in development, because strict
  mode ran its cleanup at start. The session now starts in an effect.
- Still weak: feature toggles are tested for state, not for a change in the
  rendered text. Sample words for the 21 scripts outside the featured six were
  written from the delegate's own knowledge and not checked by a reader of each
  script. The Library specimen shows the source font as imported, not edits.
  The character inspector had no link into the Studio. The integration pass
  added one.

What the Studio delegate reported as weak:

- It never took an edit through a font build. The orchestrator added
  `test/across-contexts/edited-curves-to-font.test.ts`: a node added part way along a curve and
  a stem made curved come out as whole-number quadratic curves with the same shape.
- Pointer editing was driven at 1440 only. At 390 the layout was checked, not touch.
- The specimen does not apply feature code added in the project, and says so.
- Feature switches rely on a hand-kept list of the features a shaper applies by
  default. Only `liga` is tested against real shaping.
- Vertical metrics are shown and cannot be edited.

What the Export and Proof delegate reported as weak:

- A pinned or converted build reads as inconclusive in the pixel comparison,
  because pinning rounds points to whole units. No tolerance was added. The
  screen says the check cannot tell rounding from a regression.
- A changed glyph can be untraceable in a subset of a font with no glyph names.
- Only the latest build is kept, in memory.
- A derived font kept variable is proved at its default location only.
- The two screens have no component tests. The Chrome test covers them.

What the family delegate reported as weak:

- Coordinated generation works on the weight axis only.
- A variable source with PostScript outlines (CFF2) is refused. Untested, since
  no fixture has one.
- A rebuilt variable font gets the engine check, the native validator and
  Chrome, but not the six-check report a static build gets.
- The cost estimate's default overstates: it multiplies targets by faces by
  rate, while today's model strategies make one sheet call per face. Two of the
  three listed rates are per unit with no published units per call, so they
  give no dollar figure.
- A font derived from a blank source gets the unknown-licence warning on export.

What the Generate delegate reported as weak:

- The live model strategies had never called fal when this was reported. They
  have since: see "The app's own model calls". The app holds no key, so a
  person has to paste one.
- One run takes 24 characters at most. The rest wait for the next run, and the
  screen says so.
- A stage failure has been proven in Node, not drawn in Chrome.
- Regenerating by rule or from a recorded run gives the same outline again. The
  board says so.
- The interface has no component tests. The Chrome test covers it.

What the script extension delegate measured and reported as weak. The scope is
the Devanagari subset in `src/generation/script-extension/devanagari-subset.ts`:
15 characters, 3 forms with no character, 9 test words. It is not support for
Devanagari or for any language written in it.

- All 15 characters map to their own glyph, all 3 forms are reached by layout
  rules, and 9 of 9 test words shape to the planned glyph sequence in the built
  font. Latin shapes as in the source.
- Letter identity against Noto Sans Devanagari, 10 of 10: intersection over
  union from 0.83 to 0.97. This says which letter was drawn, nothing about style.
- The new letters are lighter than Lato: headlines measure 84% of its level
  strokes and stems 86%. The model drew strokes at a fixed ratio to height.
- The two sheets came back at different weights, so a small step shows under
  the headline where a vowel sign or half form meets a letter.
- The halant sits 48 units below the face's lowest line.
- Not verified: अ, ष, ी, the halant and the half form of न in running words (no
  test word uses them); the identity of vowel signs, marks and half forms;
  marks on bases beyond the pairs measured; other shaping engines; style.
- A candidate from these sheets accepted alone carries Latin spacing and no
  layout rules. The whole change set has to go in together.

What the reconstruction core measured and reported as weak:

- Storefront banner: 19 of 19 letters found. Read correctly 16 of 19 against
  62 candidate characters (both D's and the O read as zero), 19 of 19 when told
  they are capitals. Fit of traced outline to isolated shape 0.946 to 0.990.
  Thirteen distinct letters recovered as observed candidates.
- Nearest face in the test library: Sofia Sans at weight 900, agreement 0.854.
  This is resemblance. The banner is not set in Sofia Sans.
- Fifteen more letters inferred from the recorded model run, each marked
  inferred and carrying the run that drew it. Generation's stem check fails on
  all thirteen inferred capitals, for the reason above. `fitWidthToObserved`
  squeezes them to the observed width, which brings uprights to 96 units
  against the observed 98. Level strokes stay heavier, 152 against 132.
- Controlled images (Lato, 41 letters, blurred and noisy): 39 of 41 read with
  Lato held out of the references. Agreement with the true glyph: middle 0.93.
- Copper letters photograph: fails. 0 of 5 letters isolated. Pinned by a test.
- Handwriting photograph: fails as it is. Each letter fuses with its ruled
  lines. With rule sizes set by hand the letters come out nearly clean, 0 of 4
  are read, and fit is 0.91 to 0.94 once labelled. Pinned by a test.
- Fit says the outline follows the isolated shape, not that the shape is the
  letter. Recognition depends on the reference faces in the library.
- Sidebearings split each gap in half. Only Latin is tested.

What the family screens delegate reported as weak:

- The rebuilt variable font and an unchanged variable face kept variable shared
  one file name. Fixed since: the rebuilt one is `<Family>-VariableRebuilt.ttf`.
- Stopping a run across weights discards the weights that had finished. The
  screen says so.
- A model strategy across weights is proven with a stand-in for the network
  only. No real model was called.
- A WOFF2 variable font built once in Node. It is not in a kept test and was
  never loaded in Chrome.
- The check before a variable build covers added glyphs. A source glyph redrawn
  in one master is left to the engine, whose refusal is shown as written.
- The variable font has no "Prove this font". An accepted cell on the family
  board had no link to the Studio. The integration pass added one.

What the script extension screen delegate reported as weak:

- Pinned instances are not offered the extension, because verification builds
  without a location. The screen says so.
- The test-words table prints each word in the system's type, labelled as such,
  beside the same word set in the built font.
- Proven in Node only, never drawn in Chrome: a failed run, a failed listing,
  the project's refusal, and letter identity running against a reference font.
- A running extension cannot be stopped, and its progress is one step a sheet.
- The font built for verification is not kept. A file comes only from Export.

What the Reconstruct delegate reported as weak:

- Proposing recovered letters to an existing face is covered in Node tests
  only. Chrome ran the new-face route.
- A live model call for completion was unverified when this was reported. It
  has since run once: see "The app's own model calls".
- A border inside the marked region breaks line finding. The screen warns.
- One letter of one photograph can be proposed to one face once. A candidate
  cannot be withdrawn, so re-marking the region keeps the earlier outline.
- Reading runs on the main thread, about half a second a change with two fonts.
- Evidence lives in the screen's session and is lost on reload, like the rest
  of the project.

What the integration delegate reported as weak:

- The third workflow uses a pinned Sofia Sans, not Lato, because rules can
  build few of the Latin characters Lato lacks.
- Generating by script stalled after the first run, because characters no rule
  builds filled the next run again. Fixed with the review findings: a
  procedural run now plans what a rule can build and counts the rest.
- A face reconstructed from a photograph exports with 4 of 6 checks passed and
  2 not run, since its source is an empty font with no shaping to compare with.
- Starting from an image needs a font in the project to read letters against.
  Without one the person labels each letter. The start says so.
- An address is applied again when the browser's Back returns to it, which
  replaces face and selection choices made since.
- Left as they are: the masthead's Undo while the Studio holds an unrecorded
  edit, and no "Prove this font" for a rebuilt variable font.

What the generation core reported as weak or not done:

- No height model for scripts with marks above or below a line. The uniform
  model distorts Devanagari syllables with vowel signs.
- Procedural composites place ogonek and cedilla by rule (agreement 0.85 and
  0.91 on holdouts), give tall letters the lowercase accent, and set stacked
  marks too high.
- Small capitals and obliques are plain transforms, and their evaluations say so.
- Guide lines turned more than about three degrees are not removed from a sheet.
- The fal clients report no cost, because fal states none per call.
- Compose leaves glyphs independent. It only notes which ones no character reaches.

Baseline commits before wave 1: `55f97e3c`, `81eea340`.

Note on delegate completion: completion notices do not reach the orchestrator
while the session's goal hook is active, so finished-looking delegates are read
with `task_status`.

## Independent review of the foundation

A different model reviewed the committed foundation without seeing how it was
built. It found eleven defects. Each is fixed, with a regression test.

| Finding | Fix | Test |
| --- | --- | --- |
| Text mixing right-to-left and left-to-right came out in the wrong order | Text is split into direction runs and each run is shaped on its own (`src/typeface/direction.ts`) | `test/typeface/direction.test.ts`, `test/typeface/typesetting.test.ts` |
| An accepted candidate stayed accepted after its revision was undone | A candidate is accepted only while the revision that accepted it is applied | `test/typeface/project.test.ts` |
| An accepted redraw lost its provenance | A redrawn outline carries its provenance, and a later hand edit replaces it | `test/typeface/project.test.ts` |
| Text setting repeated the base glyph in a cluster of several characters | A cluster that uses added glyphs is set one glyph per character | `test/typeface/typesetting.test.ts` |
| Text setting ignored an added glyph for a character the source already maps | The added glyph wins, as it does in coverage and the glyph list | `test/typeface/typesetting.test.ts` |
| Two candidates with one id in a single proposal were both accepted | Duplicates inside a proposal are refused | `test/typeface/project.test.ts` |
| Converting a quadratic segment to cubic changed its shape | Exact degree elevation | `test/typeface/outline-editing.test.ts` |
| An added glyph could take a source glyph's name or an already mapped character | The workspace refuses the name, the project refuses the character | `test/workspace/working-face.test.ts`, `test/typeface/project.test.ts` |
| A face with no English names read as unnamed | Falls back to the name in any language | covered by the reader change, no fixture has only non-English names |
| A damaged instance table stopped a readable font from opening | Counts are cut to what the table holds | `test/engines/harfbuzz-reader.test.ts` |
| A failed name load was cached for good | A failed load is forgotten and tried again | no test: needs a failing dynamic import |

Also from the review: a long commit now folds each face once, the workspace
caches a face's working view by history and exposes it as `workingFace`, and
the location key has one definition. Not done: sharing one HarfBuzz blob
between the faces of a font collection.

## Independent review of the screens

A different model reviewed the eight places without seeing how they were
built, by reading the code and by running the app in Chrome. Twelve findings.
The full text with the steps for each is in `.cache/review/findings.md` (not
tracked).

| Finding | Fix | Test |
| --- | --- | --- |
| Coverage shows observed and inferred candidates with the same dotted frame and the same name | The design system gained a mark and a frame for lettering traced from evidence: carbon corner brackets. One function over provenance and status decides the mark in every place | `test/typeface/provenance.test.ts`, `test/explorer/character-status.test.ts`, `test/e2e/review-fixes.test.ts` |
| An observed letter not yet accepted carries the hand-edit mark in the Studio and Reconstruct | Same change. Accepted work is solid, and the words beside it still say where it came from | `test/studio/candidates-panel.test.tsx`, `test/e2e/reconstruct.test.ts` |
| A crashed screen offers only Reload, which empties the project, and nothing asks before the page unloads | "Try this place again" keeps the project. Reload says it empties it. The page asks before unloading while the project holds a font | `test/app/screen-boundary.test.tsx`, `test/app/unload-guard.test.tsx` |
| Import's removal prompt stays open after its work is undone and prints an empty sentence | The prompt closes when its work is gone | `test/import/import-screen.test.tsx` |
| Reconstruct still offers to propose letters after their destination face is removed, and shows an internal id | The session refuses in one plain sentence and offers only to choose a destination again | `test/reconstruct/completion.test.ts`, `test/reconstruct/destination-section.test.tsx` |
| The face select in Generate overflows at 390 wide with a long face name | The fault was the field's grid track in the design system. It can now shrink, and a long name is cut with an ellipsis | `test/e2e/review-fixes.test.ts` |
| Proof shows a font built in Export as current after the project has changed | Each built font records the head revision. Export and Proof say when the project has changed since | `test/export/session.test.ts`, `test/export/results-section.test.tsx` |
| Generate's style reference is measured from the source font, while the screen says "from the face" | The words now say what is true: measured from the source font as imported, edits and accepted glyphs not counted | `test/generate/style-panel.test.tsx` |
| Regenerate rejects the earlier candidate before the new one is proposed | Proposes first, rejects only after that succeeds | `test/generate/session.test.ts` |
| A late working build in Proof can overwrite a newer one's state | One slot a face, numbered requests, and a build that is running cannot be started again | `test/proof/working-builds.test.ts` |
| Proof imports Export's internals and Coverage imports more of Library than `CONTEXT.md` allows | `CONTEXT.md` now names what crosses and why. No files moved | read by the orchestrator |
| The Studio prints unchanged source measures in carbon | A value equal to the source font's is ink | `test/studio/measures.test.ts`, `test/studio/measure-table.test.tsx` |

Fixed in the same pass, from the integration delegate's report: a face
reconstructed from a photograph now gets one warning that fits it on export
(the app cannot know whether photographed lettering is a typeface someone
owns), and its shaping check reads as not run instead of passing on spaces
alone. Procedural runs for a script plan what a rule can build and count the
rest. A pinned instance is labelled as pinned, with its location, in every
face picker.

The reviewer did not cover the variable font export, and only read family
generation and the script extension. Those three rest on their own Chrome
tests and on the orchestrator's look at their screens.

## Generation benchmark: image model against vector model

A holdout test on real output. Both models saw twelve Lato glyphs and were asked
for R, G, a, g, k and 2, which Lato already has. Agreement is intersection over
union between the generated glyph and Lato's own, after aligning them. Measured
by `test/across-contexts/generation-to-font.test.ts` on 10 November 2026.

| Glyph | GPT Image 2.6, raster sheet traced | Ideogram Vector, direct SVG |
| --- | --- | --- |
| R | 0.72 | 0.95 |
| G | 0.75 | 0.85 |
| a | 0.62 | 0.94 |
| g | 0.75 | 0.89 |
| k | 0.74 | 0.96 |
| 2 | 0.77 | 0.92 |
| Mean | 0.72 | 0.92 |
| Candidates made | 6 of 6 | 6 of 6 |
| Verdict from the evaluation | review, with style defects | pass |
| Model latency | 9.9 s | 19.9 s |

These are the figures from `bun scripts/generation/run-recorded.ts` on the
finished pipeline, and the Generate place shows the same ones in Chrome. An
earlier version of this table had lower vector figures (mean 0.89), measured
before extraction kept the model's own curves for counters.

The vector model is the better first strategy here: closer shapes, clean
outlines with no tracing step, and a listed price a hundred times lower per
unit. The image model is faster and was run at its lowest quality, so its
figures are a floor, not a ceiling. This is one request per model, so it shows
the pipeline works on real output and which way the evidence leans, not a
statistical result.
