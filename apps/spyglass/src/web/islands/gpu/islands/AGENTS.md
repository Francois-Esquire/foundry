# Islands rendering principles

## Bake chart data, sample textures to render

Islands gets its rendering performance by baking expensive chart-derived
calculations into textures, then sampling those textures during rendering.
This separation is a core architectural constraint.

- Compute coast distances, ownership, bathymetry, bank footprints, lighting,
  and other static chart fields when their inputs change. Rebuild only the
  affected maps and their dependants.
- Render the terrain and water from the published maps. Do not move chart
  traversal, island or bank searches, or static field generation into
  per-vertex, per-pixel, or per-frame work.
- Keep continuous fields on the GPU and use native texture sampling and
  filtering where appropriate. Integer IDs and masks use exact texture
  loads. Avoid replacing hardware filtering with manual reconstruction.
- Time-dependent water and view-dependent compositing still belong in the
  frame. Their inputs should reuse baked fields rather than recompute them.

## Scale preparation without taxing every frame

- Preserve the existing ordinary 2D map contract for terrain and water.
  Tile stitching, coast atlas addressing, and large bank-footprint decoding
  belong in baking or selection preparation, outside the frame shaders.
- Resolve large-chart highlight masks when selection or baked inputs change.
  Unchanged selection must not trigger a full-map resolve.
- World growth must preserve texel density. The default chart-fitted mode
  must retain its existing bounds and resolution.
- Do not silently truncate islands, banks, beaches, or selection membership
  to fit a fixed buffer or bit mask. Check device capacity and fail clearly
  when a chart exceeds it.
- Keep bake latency, resident GPU memory, and steady frame cost separate in
  measurements. Fast rendering does not establish fast rebuilds or unlimited
  world capacity.

## Preserve behavior and prove performance

- Quality refactors must preserve visuals, interaction, camera behavior,
  clipmap policy, and rendering workload. Do not bundle quality reductions or
  rendering changes into cleanup.
- Compare performance using the same chart, settings, camera, canvas size,
  device pixel ratio, and GPU. Record frame timing and actual geometry/pass
  counts; build success alone does not establish rendering performance.
- Check visual parity and high-index islands and banks, including picking,
  overlapping highlights, and world expansion. Validate changed WGSL on a
  real device using the installed vgpu CLI, as required by the root guidance.
- Prove visual parity by running `capture.ts --out=<dir>` before and after
  and comparing pixels. `close.png` and `fitted.png` vary by ±1 between
  identical runs (debris placement uses GPU atomics); anything else that
  moves is a change.
- Compare frame rate in the browser, same view and canvas. The headless
  `bench.ts` varies by up to half between identical runs, too much to show
  a drop like 75 to 60 fps.

## Code conventions

- Chart capacity is decided once, in `capacityOf` (`bake-layout.ts`).
  Don't compare island or group counts anywhere else. A limit mirrored in
  WGSL (`RING_BITS`, `BANKS_PER_PAGE`, the 64 private islands) is named on
  both sides, each pointing at the other.
- Uniforms are built by pure functions: the bake's in `map-uniforms.ts`,
  the frame's in `frame-uniforms.ts`. `maps.ts` and `scene.ts` only
  orchestrate.
- A sea parameter is its `SeaParams` field and default, its
  `MAP_OF_SEA_MAP_PARAM` entry if it is baked, and its `sea-settings.ts`
  entry; colours also go in `SEA_COLORS`. Don't write field-by-field copies.
- Map sides are powers of two: the mip chain halves whole 2×2 blocks, and
  bake tile counts round up to keep it so.
- Small- and large-chart paths are pipeline `override` constants
  (`SCALABLE_HEIGHT`, `WRITE_FOOTPRINTS`, `SCALABLE_SELECTION`), not runtime
  branches. Merging them costs small charts bake time and memory: measure
  both before collapsing either.
- Read `frame.done` a tick after a frame's callback (see `release` in
  `maps.ts` and `releaseWorkspace`). Submitting replaces it, so a read
  inside the callback gets an already resolved placeholder. These
  deferrals are not noise.
- WGSL is formatted and commented like the rest of the folder: no
  compressed one-liners.

See [README.md](README.md) for the map pipeline, current capacity limits,
and recorded validation results.

The buildings on the islands' tops follow [TOWNS.md](TOWNS.md): one file a
household, folders as streets, crowded folders built up as apartments.
