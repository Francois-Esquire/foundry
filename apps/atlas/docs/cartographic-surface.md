# Cartographic surface study

The first natural-feature pass improved evidence coverage but left the map's
visual foundation weak: enlarged coast texels, a grid that thickened with zoom,
shallow shadow artifacts, missing font assets, and file marks competing with
terrain. Adding more natural symbols did not address those problems.

## References and translation

- [Imhof's Walensee](https://ikgrelief.ethz.ch/examples/walensee/): coherent warm
  light and cool shadow make broad landforms readable. Atlas uses the existing
  evidence-derived relief for that shading; it does not invent alpine heights.
- [Zermatt, 1891](https://ikgrelief.ethz.ch/examples/zermatt/): fine engraved slope
  strokes and clear settlement lettering share a restrained paper field. Atlas
  samples short fall-line hachures from its terrain slope, below settlement ink.
- [ETH's relief design guidance](https://ikgrelief.ethz.ch/design/): relief and
  water should agree, and cast shadows can confuse the drawing. Atlas removes
  shallow land cast shadows, and gives measured water a directional inset bank.
- [Tom Patterson's NPS map design](https://www.shadedrelief.com/realism/): terrain
  belongs together as a quiet base beneath explanatory information. Lighter
  package washes and bounded coast strokes let files retain the strongest ink.

The flat-grid and screen-grain pass was rejected: it lost the terrain's physical
presence. Grid ink now follows the actual relief mesh on land and stays flat on
water. Warm lit material, a lighter stock wash, and stationary fibers replace the
flat cool slope tint and pixel noise. Full-sheet folds remain removed.

The summit/crater stamps were also rejected. They added repeated clip-art shapes
while leaving the underlying landform soft. They are removed, and every file
keeps its original visible mark. The recovery concentrates on actual terrain:
quiet low ground and rounded crests shaped by incoming imports and structural
roles. Local file covariance gives each crest a direction; compact footprints
fit individually within the unchanged shore. Taking their upper envelope leaves
saddles instead of inflating the whole island. Grid and cartographic ink follow
the same mesh that receives pointer hits. Lettering stays undistorted on raised
anchors. Optional recorded Git change cuts shallow bowls into that mesh. All
roles and counts remain inspectable in Place. Bloom starts off.

## What remains unresolved

The import graph is not a watershed. Directed cycles and unrelated crossing
relationships cannot all become noncrossing rivers while keeping fixed file
positions. Compatible mouths share trunks; omitted routes and their reasons
remain visible in Place. Some surviving arcs still look like connections rather
than tributaries. Streams remain optional and off initially.

Stream banks remain cartographic shading, not carved mesh depth.
Relief now expresses concentration and structural prominence. Commons normally supply consumers;
streams retain that direction regardless of the landmark vocabulary.

Routing is materially slower than the independent-arc baseline. A browser probe
on this workspace measured Atlas at 330–426 ms and Quirks at 146–156 ms before
moving the same construction into a dedicated worker. Cached coast checks help;
the worker prevents that construction from blocking navigation, but does not
remove total computation. A synchronous fallback remains for unavailable workers.

The map key explains structural relief, recorded-change craters, streams, and unresolved marsh.
The keyboard index retains structural roles and recorded-change evidence. Hover/selection describes the same evidence in Place and the polite live
region. The district chord chart, inland current, cycle signs, and carved stream beds are deferred rather than added to an already dense surface.

This is a cartographic height field, not a hydraulic simulation. Nearest-shore
fitting can suppress a prominent crest on narrow land, and closely spaced hubs
can still crowd one another. Height is not a precise count axis; Place carries
the counts. Actual cliffs, erosion and invented mountain ranges are excluded.


## Interaction performance

The relief pass introduced two costs on every interaction: full terrain-triangle
raycasts on pointer moves, and resampling every crest for every candidate file
label on zoom/pan. A fixed-camera triangle index preserves exact mesh picking;
file label elevations are cached until their file or terrain field changes.
The rounded compact crest profile removes needle tips without changing the
centrality signal, coastline or file positions.

Run `scripts/capture.ts` at 1500×1000 with `--pixel-ratio 2` and
`profile=pan`, `profile=zoom` or `profile=pointer` after selecting an island and
zooming in. Each step measures 100 frames after 20 warm-up frames, writes a
Chrome CPU profile, and fails when p95 dispatch exceeds 6 ms (2 ms for pointer)
or p95 frame intervals exceed 35 ms. Run comparisons sequentially on the same
machine and survey. These are diagnostic budgets, not portable CI timing tests.

Measured on this Mac in headless Chrome/WebGPU at 1500×1000 CSS pixels and
pixel ratio 2, using the same saved workspace survey:

| Interaction | Regressed terrain median / p95 CPU ms | Fixed median / p95 CPU ms |
| --- | --- | --- |
| Continuous pan | 6.0 / 6.3 | 2.1 / 2.4 |
| Zoom | 6.2–9.8 / 9.2–14.0 | 2.8 / 3.1 |
| Pointer move | 7.2 / 15.8 | 0.1 / 0.2 |

The fixed runs had p95 frame intervals of 17.5–17.6 ms. The regressed Retina
zoom runs reached 51 ms at p95; the pan-only run remained near 60 fps despite
its higher CPU cost. These measurements identify interaction overhead, not a
universal frame-rate guarantee. The parent renderer's median zoom cost was
2.8–2.9 ms, so the fix restores that cost while retaining draped terrain ink.

### Zoom-transition regression

The short, warm, alternating zoom test above missed the reported freezes. It
never left file detail and discarded its first 20 frames. A cold full-range
sweep on `f226f04` reproduced 0.5–2.14-second pauses. Chrome attributed about
9.1 seconds of a 17.4-second sweep to `setBelonging`: mesh reshaping and repeated
contour/hachure construction, including unchanged islands and hidden contours.
The saved survey has 206,062 terrain triangles, 63,878 on Atlas and 34,759 on
Quirks. Ink draws those same triangles again. The long pauses were CPU rebuilds,
not a measured triangle-throughput limit.

Terrain samples now search only overlapping compact crests. Coast masks and
unchanged contours are cached. Detailed vertex sampling and its contour/hachure
ink run in a cancellable worker. The scene retains the previous complete terrain
until the new mesh, picking, field and ink are ready together. Each island keeps
its base and latest completed evidence variant, so leaving and re-entering a
zoom level does not resample it. A semantic evidence key avoids rebuilding for
newly allocated but equivalent landmark arrays. Survey/placement changes create
a new scene. Worker-unavailable environments retain a synchronous fallback.

Camera and detail-reveal events share one requested repaint per display frame.
Viewport-resolution ink, sea ink and lettering no longer build mip pyramids
on every texture upload. Terrain topology, relief values and visual bindings
are unchanged.

Use the following **from overview in a fresh page**, without other benchmark or
validation processes running:

```sh
bun scripts/capture.ts --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --webgpu --pixel-ratio 2 --tag scroll --width 1500 --height 1000 profile=sweep shot=after errors
```

`profile=sweep@815,330` targets Quirks. The sweep runs 160 wheel events inward,
160 outward and 160 inward, then watches 60 further frames for delayed work.
There is no discarded warm-up. It exercises the real canvas handlers with
synthetic wheel events, not an OS trackpad gesture. Reports include maximum
frame interval, every interval above 50 ms, main-thread long tasks, and renderer
quality changes. It fails above 100 ms maximum or 35 ms p95 frame interval;
handler dispatch must also stay below 6 ms p95. Handler timing excludes queued
painting, so judge the frame intervals and Chrome profile as well. Metrics JSON
and CPU profiles are saved even on failure, and remaining screenshot/error
steps still run.

The older `1496169` viewer reached 66 ms maximum and 13 ms p95 wheel-handler
cost on the same sweep. Indexing alone reduced the new worst pause to 446 ms;
contour caching reduced it to 221 ms; the worker removed those long rebuild
pauses. Final repeated results and the remaining GPU limit are recorded below.


Retina sweeps after the CPU fix exposed a separate GPU limit. With post-processing
off, the sweep peaked at 35.5 ms with a 17.8 ms p95. Disabling only screen-space
occlusion retained grading and reached 62.5 ms maximum / 17.8 ms p95. Merely
quartering its low-tier resolution did not reliably meet the frame budget, so
that experiment was discarded. Light now keeps the terrain's engraved concavity
and full-resolution ink without the chart's screen-space occlusion pass. Balanced
and Full, explicit occlusion previews, and perspective wreck views retain it.
The default remains Balanced; the existing measured-GPU adaptation selects Light
when needed. The panel explains Light's tradeoff. Direct rendering now drains
GPU timestamp queries too, fixing a query-pool warning exposed by the comparison.

Atmosphere ticks also avoid submitting another frame when camera movement has
already drawn one. A subsequent isolated Atlas sweep measured 78.3 ms maximum / 31.0 ms p95;
Quirks measured 105.4 ms maximum / 32.7 ms p95. Neither recorded a main-thread
long task. Quirks still failed the 100 ms maximum-frame budget. Warm pan measured 17.4 ms p95 frame intervals,
and pointer dispatch measured 0.5 ms p95. Earlier repeated post-worker runs varied
and some still failed the 35 ms p95 budget. The half-second and two-second rebuild
freezes are removed; occasional GPU/frame-pacing hitches remain. These headless
Chrome results do not establish uniformly smooth OS trackpad behavior or a
60-fps guarantee on other hardware.


Validation: repository `bun run validate` passed; Atlas `bun x vitest run`
passed 1,409 tests in 110 files. The regression coverage includes unchanged
height samples, cancelled worker results, evidence-equivalent zoom revisits,
contour cache invalidation, merged repaint requests, duplicate atmosphere
frames, low-tier occlusion behavior, and draining direct-render timestamp queries.
Four-scale captures for both islands are under `.cache/shots/scroll-final-light-*`
and `scroll-final-quirks-*`. Their meaning is unchanged; Light has visibly softer
contact shading. WebGPU captures report zero console errors. The remaining cold
GPU/frame-pacing spikes mean the overall scrolling-performance issue is improved,
not fully closed.
