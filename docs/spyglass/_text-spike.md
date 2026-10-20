# Spyglass text spike

Maintainer note, excluded from the Blume site. Dated 2026-10-17. The spike
[`_renderer.md`](./_renderer.md) gates on: how the chart's text maps to
Canvas2D today, and what replaces it when the Canvas2D path goes. Two
candidates were built inside the real viewer scene and compared on equal
footing, with two more tried briefly. The recommendation and its consequence
for decision 1 of the renderer plan are at the end. Nothing here is merged;
the prototype paths are listed in the last section.

Everything was run on three r185.1 (`WebGPURenderer`, TSL node materials),
Vite 8.2.2, headless Chrome 155.0.8059.80 on Apple Metal through
`agent-browser --webgpu`, at a 1280 × 633 CSS-pixel viewport, with the test
fixture `apps/spyglass/test/fixtures/spyglass.json` (15 islands, 1,665
files, one frame) fed straight to `createSpyglassScene`. The WebGL 2 backend
was exercised by hiding `navigator.gpu` before the scene was built.

## Part 1: how text maps to Canvas2D today

### Where text is drawn

Five modules call `fillText`/`strokeText`; nothing else under `src/web`
draws text.

| Module | Draws | Into |
| --- | --- | --- |
| `scene/ink/labels.ts` | island names and captions, the selected file's name, file names, folder names, region names, the domain's name, frame labels | the lettering canvas (`labelContext`) |
| `scene/paint-paper.ts` `paintGridReferences` | column letters and row numbers | the lettering canvas |
| `scene/ink/latitude-scale.ts` | `FOUNDATION · 0`, `LAYER n` | the lettering canvas |
| `scene/ink/compass.ts` | the compass `N` | the ink canvas |
| `scene/ink/sea-caption.ts` | `The dependency sea` and the caveat line | the ink canvas |

The two canvases are wired in `scene/paint-map.ts`: `paintInk` runs every
`inkLayers` entry in z-order with the ink context and, when
`options.lettering` is given, a second context on the lettering canvas
(`letteringContext`), both transformed by `collectScale` so that drawing
happens in map units at the current view. The ink canvas becomes the texture
the relief layer drapes over the terrain and the sea plane shows; the
lettering canvas (`scene/lettering.ts`, `createLettering`) becomes a texture
on a flat `PlaneGeometry` scaled to `view.width × view.height` map units at
`z = paperThickness + 0.02`, `depthTest: false`, `renderOrder 3`, so text is
never occluded by terrain and never lit. Both canvases are re-rasterised and
re-uploaded on every repaint (`inkTexture.needsUpdate`).

Three typefaces are involved, not two: `SpyglassDisplay` (Abril Fatface
Regular, TTF, 67 KB, 425 glyphs), `SpyglassBody` (Inter Regular, a 16.7 KB
WOFF2 subset of 345 glyphs, 225 characters), and `Georgia`, a system font
used for region names and the sea caption. Folder names ask for `italic
SpyglassBody`, which the browser synthesises, since no italic is bundled.
Both bundled fonts cover every character the chart uses (ASCII, `·`, the
typographic dashes and quotes); `src/web/ui/spyglass.css` declares the
`@font-face`s and `ui/spyglass-map.tsx` awaits `document.fonts.load` for
both before the scene is built. Licences, from `public/fonts`: both are
SIL OFL 1.1. Abril Fatface carries Reserved Font Names "Abril" and "Abril
Fatface", so a derived file (an atlas, a converted TTF) must not be
distributed under that name; Inter reserves none. Neither licence blocks any
candidate below.

### The geometry of text on the chart

Because `collectScale` scales the lettering context by `pixelsPerUnit`
horizontally and `pixelsPerUnit · cos(tilt)` vertically (the plane's
`view.height` is the camera's height divided by `cos 0.7`), every glyph on
both canvases is foreshortened on screen to **cos 0.7 ≈ 0.765 of its nominal
height**. A "20 px" file name is about 15 px tall. This is the "engraved on
the paper" look; it was confirmed by overlaying the DOM prototype with
`scaleY(cos 0.7)` on today's lettering, where the two coincide
(`shots/dom-squash-over-canvas-overview.png`).

Labels on an island are lifted over the relief by `createLabelProjector`
(`scene/lettering.ts`): the anchor moves by `−elevation · tan(tilt)` in map
y, where `elevation = islandPlinth + field.sample(x, y).elevation`, cached
per file. Projecting the lifted anchor on the flat plane and projecting the
true 3-D point `(x, −y, z + elevation)` through the tilted orthographic
camera land on the same pixel; the prototype measures the difference every
frame and reports 0.000 px at all three zooms. A frame's label and any label
whose anchor is outside the coast are not lifted.

### The inventory

Sizes are CSS pixels unless marked "map units". "Halo" is the
`strokeText` width in screen pixels (half of it shows), in
`grounds.labelHalo` (`#f5efdf`). "Lifted" means `createLabelProjector`
applies. "Hit" means `labelUnder` (`scene/exploration.ts`) returns it.

| Text | Anchor | Face and size | Halo | Order, collision, budget | Zoom gating | Lifted | Hit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Island name | world: `(p.x, p.y + territoryLabelY(p))`, 17 map units north of the northernmost coast point, on the sea | `SpyglassDisplay`, `territoryLabelSize(radius)` (0.15 r clamped 13–22) then clamped to 12–26 px on screen | 6 (sea) | after region, folder and the selected file's name; candidates sorted selected first, then by file count; `visibleLabels` rectangle collision with a 5 px gap (10 px on a portrait view) | drawn when the clamped size is ≥ 9 px | no: the anchor is outside the coast, so the projector leaves it | yes → island |
| Island caption | 14 px under the name | `SpyglassBody` 9.5 px, letter-spacing 1.4 px, `inks.labelCaption`; "639 FILES", "· NO LAYER", "· FRAME" | 5 | part of the name's box for collision; `clipToSea` widens the box by 18 px for it | with the name | with the name | with the name |
| Selected file's name | world: file, 21 px above | `SpyglassBody` 20 px, `inks.selection` | 6 (selected) | first candidate: wins every collision | `detail.files + detail.composition > 0.1` | yes | yes → file |
| File names | world: file, 7 px above; on the selected or belonging island only | `SpyglassBody` 15 px (17 px when the belonging layer lists files), `inks.label`, opacity `detail.files` | 3 (land) | ordered by `labelPriority` (dependents + dependencies) desc; budget `max(3, ⌊area · px² / 40 000⌋)` (26 at the close zoom on this viewport); skipped while the focused file is in view | `pixels ≥ 5` and `detail.files ≥ 0.5` (fade 3–5 px/unit) | yes | yes → file |
| Folder names | world: the cell's centroid, one line above | `italic SpyglassBody` 13 px, `inks.folder`, trailing `/` | 3 | after region names, before island and file names | `pixels ≥ enteredAt` (1.8) and the island's cells shown | yes | yes → island |
| Region names | world: the region's anchor member, 8 or 36 px above | `Georgia` 15 px, opacity `detail.districts` × reveal | 3 | first after the selected file's name; budget `max(2, min(6, ⌊area · px² / 90 000⌋))`; parents before regions, larger first; dropped when a folder of the same name is shown | `detail.districts` (in 1.2–1.8, out 3–5 px/unit); parents stay at 0.2 | yes | yes → region or composite |
| Domain name | world: once, at the largest piece in view | `SpyglassBody` 13 px, `inks.domainName`, "domain node-runtime" | 6 | second candidate, so it wins all but the selected file | when a domain is chosen | yes, if inside a coast | no, passes through |
| Frame label | world: centred over its frame's islands, 18 px above the northernmost name, moved west of the compass | `SpyglassBody` 14 px, upper case, letter-spacing 3 px (measured with it) | 6 | before island names | collections only (`frames > 1`) | no | no |
| Grid references | screen: 18 px from the top edge and the left edge, at each major cell | `SpyglassBody` 10 px, letter-spacing 1 px, `inks.grid` | 3, `inks.gridReferenceHalo` | margin note: no collision; suppressed within 14 px of a placed label | always (major step is fixed at 90 units) | no | no |
| Latitude scale | screen x (34 px from the right edge), world y (each layer's latitude) | `SpyglassBody` 10 px, letter-spacing 1 px, right-aligned, `inks.scale`; paper plate on views narrower than 760 px | 3 | margin note; stops 96 px from the foot or above the legend | fades with `detail.scale = 1 − fade(1.2, 1.8)` | no | no |
| Compass `N` | world: the compass centre, 43 map units up | `SpyglassDisplay` **10 map units** (scales with zoom), `inks.compass` | none | none | always | no (on the ink canvas, projected onto the sea) | the compass disc is: 40 units → settings |
| Sea caption | world: the south margin | `italic Georgia` **14 map units** and `SpyglassBody` **6 map units**, `inks.seaCaption` | none | none | always | no | no |

Every readable label is measured with `ctx.measureText` on the lettering
context, with the letter-spacing it will be painted with, at the moment it
is proposed (`add` in `labels.ts`); the width and the font size become its
`MapLabel` box in map units. The placed boxes are then a shared output of
the repaint: `topography.ts` clips contour lines out of them, `clipToSea`
in `selection-ink.ts` keeps the selection's lines out of them, grid
references keep clear of them, the hover layer asks `hovered(labels)` so a
label is hit before the land beneath it, and `resolveHit` in `scene.ts`
tests `labelUnder` on the pointer's point on the paper plane before the
terrain pick. Whatever draws the glyphs, the boxes stay a layout output.

Real counts with the fixture: 12 labels at the named overview of 1 px per
unit (island names; three islands fall outside this viewport) and 15 at the
viewport's default fit of 0.65 px per unit, 4 at the island zoom (2.2) with
the largest island selected (its name and three folders), 28 at the close
zoom (10) on the same island (two folders and 26 files, the budget).
Hundreds of labels is a stress case, not an operating point.

## Part 2: text on WebGPU

The harness, `apps/spyglass/scratch/text-spike/main.ts`, builds the real
scene and hides the lettering plane; a throwaway `spike` hook added to
`SpyglassSceneOptions` hands each drawn frame's camera, placed labels, view
and terrain fields to the candidate. Each candidate is driven from the URL
and reports update cost, the viewer's own `ink:labels` and `render-submit`
timings, and the GPU frame time where the device reports it.

### A. Semantic DOM overlay

A `<ul aria-label="Chart labels">` over the canvas with one `<li>` per
placed label. Each frame: one read pass (project the anchor through the
camera with `Vector3.project`, width from a measurer), one write pass
(`font`, `-webkit-text-stroke` with `paint-order: stroke fill` for the halo,
`transform: translate(...)`). Widths come from a hidden `<span>` measured
once per face, style, letter-spacing and string at 100 px and scaled
linearly; the same strings were also measured with `measureText` at the
same 100 px, and the two agree to 0.007 % of an em (mean over 669 strings).
The linear scaling to 9.5–26 px was not measured separately; Chrome's
sub-pixel glyph positioning is what makes it hold. The overlay has
`pointer-events: none`; items with a territory get `tabindex=0` and an
accessible name.

What was seen:

- Both fonts and Georgia render as the browser renders them: hinted,
  sub-pixel positioned, crisp at 9.5, 13, 15 and 26 px, at every zoom,
  because nothing is rasterised to a texture (`shots/dom-close.png`,
  `shots/crops/dom-close-belonging.png`). Synthesised italic for folders and
  letter-spacing for captions come free.
- The halo is a centred text stroke painted under the fill, which is what
  `strokeText` then `fillText` does; widths 3–6 px reproduce today's look.
- Cost: 0.15 ms per frame for the 28 real labels at the close zoom; 1.0 ms
  mean (1.9 max) for 272 elements; 2.6 ms mean (4.6 max) for 672 elements;
  the render submit stays at 0.4–0.5 ms. The naive version re-styles every
  element every frame. A pan can instead translate the list once and
  re-position items only on zoom or repaint, so the steady-state pan cost is
  one transform.
- Pointer: a drag that starts on a label pans the map (view x moved by the
  drag's 200 px ÷ 10 px/unit = 20 units); a click through the overlay
  selects `belonging.ts` through today's `labelUnder`; nothing about hit
  testing changes.
- Accessibility: `agent-browser snapshot` shows a list named "Chart labels"
  with items "src/, folder in spyglass", "types.ts, file in spyglass", each
  focusable; Tab moves a visible focus ring between them
  (`shots/dom-focus.png`). Enter on a focused item can select through the
  same path a click takes.
- Terrain lift and tilt: projecting the true 3-D anchor matches today's
  placement to 0.000 px, so the lift is a z, not a y shift, and the
  projector goes.
- Depth: DOM text is always on top. Today's lettering already is
  (`depthTest: false`, `renderOrder 3`), so nothing is lost; an element
  behind terrain cannot be occluded, which the chart never wanted.
- Look: DOM text is upright. Today's is foreshortened by cos 0.7. Either
  `transform: scaleY(0.765)` on each item reproduces the engraved look
  (confirmed by overlay) or the chart adopts upright lettering; this is a
  design choice to take at phase 4, and the phase 0 screenshots differ by
  it.

Not tested: a collection's frame labels and Georgia region names, which need
the belonging layer and a second frame the fixture lacks; both are plain
styled text and carry no new mechanism.

### B. MSDF glyphs through a node material

`three-msdf-text-utils` 1.5.0 (peer `three >= 0.178`) exports
`MSDFTextGeometry` and `MSDFTextNodeMaterial` from its `/webgpu` entry; the
material imports `NodeMaterial` from `three/webgpu` and `uv, texture, fwidth,
smoothstep, …` from `three/tsl`. Atlases were generated with
`msdf-bmfont-xml` 2.8.0, whose bundled `msdfgen.osx` runs on arm64; Inter's
WOFF2 was decompressed to TTF with `wawoff2` first (the tool reads TTF/OTF
only). Two sets, 103 characters each: 48 px with distance range 16 (512 ×
512, about 200 KB PNG per font) and 64 px with range 56 (1024 × 1024, about
600 KB per font).

What was seen:

- It compiles and renders under `WebGPURenderer` on both backends with no
  errors (`shots/msdf-halo-wide-close.png`, `…-webgl.png`). The first run
  drew nothing: the glyph quads are built y-down and flipping them with a
  negative scale back-face culls them; `side: DoubleSide` fixes it.
- The library's stroke is a band centred on the glyph edge and composited
  over the fill (`color = mix(fill, stroke, border)`), not a halo behind it.
  A paper halo is ten lines of TSL on `MeshBasicNodeMaterial`: signed
  distance `(median(rgb) − 0.5) · range`, divided by `fwidth` to get screen
  pixels, fill alpha at `d + 0.5`, halo alpha at `d + haloPx + 0.5`, colour
  `mix(halo, fill, fillAlpha)`. That is what the prototype renders
  (`mat=halo`); the library material is `mat=lib`.
- The halo width is bounded by the atlas: at most `range / 2` atlas pixels,
  scaled to the rendered size. The default range 16 at 48 px allows 2.2 px
  at 13 px text, under today's 3 px land halo. Range 56 at 64 px allows 5.7
  px at 13 px, 6.6 px at 15 px, 4.2 px at the 9.5 px caption (which wants
  5), 11 px at a 26 px island name; that is the 1024 × 1024 set. Beyond the
  range the field saturates and the halo becomes the glyph's padded
  rectangle.
- Metrics: summing `xadvance` and kernings from the atlas JSON matches the
  font's own advances (fontkit) to −0.6 … +1.4 %, the error being
  integer-rounded advances at the atlas size. `geometry.layout.width` is
  not that number: it ends at the last glyph's bitmap edge and includes the
  padding, 5–10 % over. Collision must sum advances.
- Quality: legible, but visibly softer than native text at 12–16 px, with
  the MSDF corner artefacts on the Abril name with the narrow atlas and
  muddied counters with the wide one (`shots/crops/msdf-island-name.png`,
  `shots/crops/msdf-close-belonging.png`). The library's `isSmooth` mode for
  small sizes was not tuned. Text is foreshortened like today's, since it
  lies on the paper plane.
- Fonts: Georgia cannot be atlassed (system, proprietary) and no italic is
  bundled, so region names, the sea caption and folder italics need
  substitutes or a third and fourth atlas from a bundled face.
- Cost: 0.04–0.5 ms CPU per frame; the render submit grows from 0.5 ms (28
  meshes) to 1.8 ms (272) to 4.0 ms (672) with one mesh per label; batching
  labels per font into one geometry would make it one draw call per face.
  GPU frame time at the close zoom was 3.2–3.5 ms for the whole scene.
- Accessibility: none. Names would have to be mirrored into hidden DOM
  anyway for a screen reader, which is candidate A without the pixels.

### C. troika-three-text

`troika-three-text` 0.52.5 under `WebGPURenderer` (WebGPU backend): every
render throws `TypeError: Failed to execute 'drawIndexed' on
'GPURenderPassEncoder': Value is infinite and not of type 'unsigned long'`
from `WebGPUBackend._draw`, for its instanced glyph geometry; nothing is
drawn (`shots/troika-overview.png`). On the WebGL 2 backend there is no
error and each label renders as a single dot (`shots/troika-webgl-overview.png`),
since its `onBeforeCompile` shader patching does not apply to node
materials. Fail on both; not pursued further.

### D. Others

pmndrs/text is not published to npm under that name (the search finds
`troika-three-text` and `@pmndrs/uikit`) and was not tried. A hand-rolled
SDF through TSL is candidate B with the library removed: the atlas tool and
the ten-line material are the whole of it, and the prototype's `mat=halo`
already is that; it inherits every finding above, including the small-size
softness and the missing third font. three's own `TextGeometry` (filled
outlines from a `typeface.json`) renders crisp vector glyphs at any size and
needs no atlas, but has no halo, needs a converted font file, and costs a
triangulated mesh per string; it would do for a single mark such as the
compass `N` if that were ever wanted on the GPU.

### Comparison

| | A. DOM | B. MSDF node material | C. troika |
| --- | --- | --- | --- |
| Both bundled fonts | yes | yes | – |
| Georgia and italic | yes, free | no | – |
| Metrics for collision | DOM measure, 0.007 % of em from `measureText` | atlas advances, within 1.4 % | – |
| Crisp at 9.5–26 px, every zoom | yes, native | soft at ≤ 16 px | – |
| Halo | `-webkit-text-stroke` + `paint-order`, any width | bounded by atlas range; wide atlas needed | – |
| Cost at 28 labels | 0.15 ms CPU | 0.04 ms CPU + 0.5 ms submit | – |
| Cost at 672 labels | 2.6 ms CPU (O(1) pan possible) | 0.5 ms CPU + 4.0 ms submit (batchable) | – |
| Hit testing | unchanged (`labelUnder`); pointer passes through | unchanged | – |
| Accessibility | names, focus, screen reader for free | none | – |
| Backends | independent of the renderer | WebGPU and WebGL 2 | fails on both |
| Fits the declared tree | a named `labels` layer with measurable counts; its marks are elements | a mark primitive like the others | – |
| Assets | none | two to four atlases, 0.7–1.4 MB | – |

## Recommendation

Text becomes a semantic DOM layer beside the GPU scene. Every readable label
in the inventory (island names and captions, file, folder, region, domain
and frame labels) is an element positioned each frame from the camera, and
so are the margin notes (grid references, the latitude scale), which are
screen-anchored already. The two world-scaled strings on the ink canvas, the
compass `N` and the sea caption, are the same elements with a font size in
pixels per unit; nothing in the inventory needs to be lit, occluded or
post-processed, so nothing needs GPU glyphs. A hybrid with MSDF chrome is
not recommended: it keeps an atlas pipeline and a second text system for two
strings that the DOM layer draws better.

The evidence: the DOM layer is the only candidate that renders all three
faces crisply at the chart's sizes, measures within rounding of today's
`measureText`, keeps hit testing exactly as it is, costs a fraction of a
millisecond at the real label counts, and gives names, focus order and a
screen-reader structure without extra work. MSDF works, and is the answer if
text ever has to sit inside the lit scene, but it is softer at small sizes,
bounded in halo width by atlas size, blind to Georgia and italic, and
accessible only by mirroring the names into the DOM anyway.

Consequence for [`_renderer.md`](./_renderer.md), decision 1: amended to
"one GPU context for marks, one semantic layer for text". The declared tree
gains a `labels` node whose renderer is DOM, measured like the others (build
time, update time, elements placed). The seam does not move: `layout/` still
proposes labels and places them (`visibleLabels`, the budgets, the
`MapLabel` boxes the other layers consume); only the text measurer changes
from `ctx.measureText` to a cached DOM (or detached-canvas) measure in the
view leaf, and the glyph drawing moves from `paintLabels` to the layer.
`createLabelProjector` and `elevatedLabel` are deleted; the label's anchor
carries its elevation and the layer projects the 3-D point. Phase 5's "no 2D
context remains under `src/web`" holds if the measurer uses the DOM; if it
uses a detached canvas for `measureText`, the phrase becomes "no 2D context
draws". Hit testing stays analytical in `interaction/`: the layer is
`pointer-events: none`, and keyboard selection joins through the same
`onSelect` path. One more consequence, for the plan's verification bullet:
a GPU render-target readback never sees a label once text is in the DOM,
so a contrast check against the ladder's floors must read a composited page
capture. `scripts/capture.ts` already does (`Page.captureScreenshot` over
CDP), so the existing capture path keeps the labels; a `readRenderTargetPixels`
check would be for marks only.

Semantic structure to adopt: a `<section aria-label="Chart">` holding a
`<ul>` of islands, one `<li>` per island with its name and caption as the
accessible name ("spyglass, package, 639 files"), each holding a nested
`<ul>` of the folders, regions and files currently labelled on it ("src/,
folder", "belonging.ts, file"). Only placed labels exist as elements, so the
tree is as long as the chart is readable, not 1,665 items; the island items
are always present. Margin notes are `aria-hidden`.

## Open risks

- **The engraved look.** Upright DOM text is a visible change from today's
  foreshortened lettering. `scaleY(cos 0.7)` on each item reproduces it
  exactly, at a slight cost in crispness since it is a transform, not a font
  size. Decide at phase 4 and take the phase 0 screenshots knowing which.
- **Colour through the pipeline.** The lettering plane is in the scene
  today, so tone mapping and saturation touch it; a DOM halo in
  `grounds.labelHalo` sits outside the pass graph and may not match the
  paper under it when the pipeline is on. Not measured here. The ladder's
  contrast floors are the check; the halo may need to be the paper's
  post-pipeline colour.
- **Sub-pixel motion.** Elements move on CSS-pixel transforms while the
  scene moves on the GPU; during a pan they can appear to drift by a
  fraction of a pixel relative to the terrain. Rounding transforms to device
  pixels, or translating the whole list during a pan, is the fix to try.
- **Stacking.** DOM text is above everything, including the phase 7 clouds
  and any bloom. Today's lettering is already above everything, so this is
  the present behaviour, but it closes the door on text under weather.
- **Frame labels and region names** were not exercised (single-frame
  fixture, no belonging layer); they are plain styled text.
- **MSDF, if ever needed.** The small-size softness was not tuned
  (`isSmooth`, a larger atlas size, `msdf-atlas-gen` instead of
  `msdf-bmfont-xml`); the figures above are a first atlas, not a best one.

## Prototype files

All under `apps/spyglass`, throwaway, not for merge:

- `src/web/scene/scene.ts`: the `spike` option and `SpikeFrame` (39 added
  lines, marked `TEXT SPIKE`); the only change to viewer source.
- `scratch/text-spike/index.html`, `scratch/text-spike/main.ts`: the
  harness and all three candidates, driven by `?mode=canvas|dom|msdf|troika`,
  `&mat=lib|halo`, `&wide=1`, `&webgl=1`, `&squash=1`, `&keep=1`,
  `&select=<package>`, `&view=x,y,pixels`, `&stress=N`, `&bench=N`;
  results in `#result` and the on-screen HUD. Serve with
  `../../node_modules/.bin/vite --port 5179` from `apps/spyglass` and open
  `/scratch/text-spike/index.html`.
- `scratch/text-spike/package.json` and its `node_modules` (installed with
  npm, no lockfile, so the root `bun.lock` is untouched):
  `three-msdf-text-utils`, `troika-three-text`, `msdf-bmfont-xml`,
  `fontkit`, `wawoff2`.
- `scratch/text-spike/glyphs.mjs` (font coverage),
  `decompress-inter.mjs` (WOFF2 → TTF), `metrics.mjs` (atlas advances
  against the font), `charset.txt`.
- `scratch/text-spike/atlas/` (48 px, range 16) and `atlas-wide/` (64 px,
  range 56): the MSDF JSON and PNG for both fonts.
- `scratch/text-spike/shots/`: the screenshots cited above, and `crops/`.
