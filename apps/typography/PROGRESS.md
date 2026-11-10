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
| A variable font is rebuilt from pinned-instance masters with fontTools varLib. | In the engine as `FontBuilder.buildVariable`. Three masters of Sofia Sans (954 glyphs) build in about 11 s in the Chrome worker and 13 s in Node. Interpolation between masters is linear: the source's `avar` mapping and intermediate designs are dropped, and the engine says so in its notes. |
| A reconstruction that starts from an image gets a blank source font made by the engine. | The project model stays uniform: every face has a source font, and reconstructed letters arrive as candidates on it. In the engine as `FontBuilder.blankFont`. The same request always gives the same bytes. |
| A model draws vowel signs on a known base letter, and the pipeline separates them. | Asked for Devanagari vowel signs alone, the model attached them to base letters. Asked for syllables on क, it drew all eight correctly. |

## Acceptance ledger

| Phase | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Import two fonts with different script coverage, one variable | `test/engines/harfbuzz-reader.test.ts`, `test/workspace/import.test.ts`, `test/workspace/font-collection.test.ts` | partial: reading and import done, screens being built |
| 1 | Correct coverage | `test/unicode/coverage.test.ts`, `test/unicode/data.test.ts` (data equals the Unicode 17 package) | partial: coverage arithmetic done, screen being built |
| 1 | Working specimen controls | | screen being built |
| 1 | Unchanged original-file export | `test/spine.test.ts`, `test/workspace/export.test.ts` | partial: export returns the identical bytes, screen being built |
| 2 | Edit a glyph or its metrics, preview in text, source preserved | `test/spine.test.ts`, `test/typeface/outline-editing.test.ts`, `test/typeface/typesetting.test.ts` | partial: model, instant preview and build done, screen being built |
| 3 | Modified font loads independently with intended coverage and shaping | `test/spine.test.ts`, `test/packaging/`, `test/integration/packaging/independent-validation.test.ts` (native fontTools and the OpenType Sanitizer accept edited, pinned, subset, WOFF2 and CFF builds), `test/integration/packaging/browser-engine.test.ts` (Chrome builds through the worker and loads the result) | partial: engine, plans, licence checks and independent validation done, screens not started |
| 4 | Real generated candidates, normalised, refined, in a derived font | `test/generation-to-font.test.ts`: the recorded output of two real models becomes six candidates each, one is accepted, edited by hand and built into a font that validates and still shapes. Raw output in `test/fixtures/generation/2026-11-10-latin-holdout` | partial: proven at the model level, screen not started |
| 5 | A defined script extension with functional shaping | `test/script-extension.test.ts` (stand-in outlines), raw model output in `test/fixtures/generation/2026-11-10-devanagari-subset` | partial: shaping machinery proven, generated outlines not yet through it |
| 6 | Coordinated faces or a valid variable font | Prototype `.cache/exp/varbuild.py` (not tracked) | not started in the app |
| 7 | Usable candidates recovered from a real image, editable | Evidence in `test/fixtures/evidence` | not started |
| 8 | Integrated workflows end to end | | not started |

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
recorded. The app's own call to fal has never run. What is known about it: the
request it builds is tested against a stand-in for the network, and fal answers
a browser's preflight for a POST with an Authorization header from a local
origin (checked on 10 November 2026 with one request that ran no model).

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
| 5 | Family generation in Generate and Export | `src/generate/family`, `src/export/variable`, `test/e2e/family.test.ts` | `de4f757b-925b-462f-8f2c-1abb6a646764` | running |
| 5 | Script extension in Generate | `src/generate/script-extension`, `test/e2e/script-extension.test.ts` | `94dd090f-d54f-4e23-bd8d-5de2319e7837` | running |
| 5 | Reconstruct place | `src/reconstruct`, `test/e2e/reconstruct.test.ts` | `b88ae059-c92c-4767-9114-f45791bef26d` | running, started while the reconstruction core was still in flight |

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
  The character inspector has no link into the Studio.

What the Studio delegate reported as weak:

- It never took an edit through a font build. The orchestrator added
  `test/edited-curves-to-font.test.ts`: a node added part way along a curve and
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

- The live model strategies have never called fal. They are tested in Node
  against a stand-in for the network. The app holds no key, so a person has to
  paste one.
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

## Generation benchmark: image model against vector model

A holdout test on real output. Both models saw twelve Lato glyphs and were asked
for R, G, a, g, k and 2, which Lato already has. Agreement is intersection over
union between the generated glyph and Lato's own, after aligning them. Measured
by `test/generation-to-font.test.ts` on 10 November 2026.

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
