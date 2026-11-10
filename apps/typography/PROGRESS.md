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
| A variable font is rebuilt from pinned-instance masters with fontTools varLib. | Prototyped natively on Sofia Sans: two masters at weight 200 and 800, each given the same added glyph with the same point structure, build into one variable font in about 3 s, and the added glyph interpolates. Not yet in the engine. |
| A reconstruction that starts from an image gets a blank source font made by the engine. | The project model stays uniform: every face has a source font, and reconstructed letters arrive as candidates on it. Prototyped natively. Not yet in the engine. |
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
drew all fifteen requested glyphs correctly and matched the banner's weight, but
drew them wider than the banner's condensed letters. The evaluation has to
measure width against the observed letters, and refinement has to correct it.

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
| 2 | Studio place | `src/studio`, `test/e2e/studio.test.ts` | `4e899de4-d501-4f11-ad15-8e53f1f90254` | running |
| 3 | Export and Proof places | `src/export`, `src/proof`, `test/e2e/export.test.ts` | `4a66cee3-45cd-46db-8b8b-c8bf3f9d0e88` | running |
| 3 | Family generation and variable fonts | `src/packaging`, `src/generation/family` | `4b7b22c5-18ca-4df3-ac05-4cdfb072ea03` | running |
| 3 | Reconstruction core | `src/reconstruction`, `scripts/reconstruction` | `51c27c42-497b-4141-a1d5-9c4b2c5c77d1` | running |
| 4 | Script-aware generation (Devanagari subset) | `src/generation/script-extension`, `scripts/generation/extend-script.ts` | `de7ffdba-271e-45b1-8c9b-8030b5f63aa4` | running |
| 4 | Generate place | `src/generate`, `test/e2e/generate.test.ts` | `ce5cdda1-c853-4b6b-b5f9-925d305b2b94` | running |
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
| R | 0.72 | 0.91 |
| G | 0.75 | 0.80 |
| a | 0.62 | 0.95 |
| g | 0.75 | 0.87 |
| k | 0.73 | 0.96 |
| 2 | 0.80 | 0.87 |
| Mean | 0.73 | 0.89 |
| Candidates made | 6 of 6 | 6 of 6 |
| Verdict from the evaluation | review, with style defects | pass |
| Model latency | 9.9 s | 19.9 s |

The vector model is the better first strategy here: closer shapes, clean
outlines with no tracing step, and a listed price a hundred times lower per
unit. The image model is faster and was run at its lowest quality, so its
figures are a floor, not a ceiling. This is one request per model, so it shows
the pipeline works on real output and which way the evidence leans, not a
statistical result.
