# Spyglass screen terrain

Maintainer note, excluded from the Blume site. Dated 2026-10-19. This note
records the plan for computing the geology preview's terrain on the GPU at
about one sample a screen pixel, at any zoom, and shading it per pixel; the
prototype that tests it, the hidden "Screen terrain" layer; and the steps
from here to making it the preview. The terrain itself is described in
`_geology.md` and `_terrain.md`.

## Why the preview reads as low resolution

Everything is computed on the CPU and baked into mesh vertex attributes,
so shading can be no finer than the vertices:

| What | Resolution |
| --- | --- |
| World terrain grid (`world-terrain.ts`, `terrain.ts` cell 4) | 4 map units, 527 × 527 cells over ±1,054 |
| Lattice (`geology-lattice.ts`, `refine: 4`) | 1 unit within 12 units of a coast, 4 elsewhere, long quads to the sea's edge |
| Colour, occlusion, shadow, normals (`geology-layer.ts`, `bakeRelief`) | Baked at 4 units, interpolated between vertices |
| Plate edges (`createContourTexture`) | 4-unit texture, bilinear |
| Open-sea emanation (`ocean-emanation.ts`) | About 11.6 units a texel |

At the overview a device pixel spans about 1–7 map units, depending on
the window; close up it is a twentieth of one. Shelf edges then stair-step
on the 4-unit cells, beaches step on the 1-unit lattice, and contours and
plate lips wobble with the grid. Doing ten times better by brute force on
the CPU means 0.4-unit cells, about 28 million samples: not feasible.

## Measurements

All on `test/fixtures/spyglass.json` (15 islands, 21 coast polygons,
3,494 coast segments; formations: 5 plateau, 4 volcanic, 2 seamount, 2
cluster, 1 ridge, 1 atoll). CPU times are Bun on an Apple M4 Max, a cold
first build; GPU times are headless Chrome 154 on the same machine.

The current preview's build:

| Stage | ms |
| --- | --- |
| `chartTerrain` (structural) | 133 |
| `archipelagoPlatform` | 312 |
| `chartSeafloor` | 225 |
| `islandLandforms` | 51 |
| `worldTerrain`, cold (everything above cached) | about 740–1,900 between runs |
| of which `previewCoasts` | 187 |
| of which `coastMask` + `maskDistance` + `pieceDepths` | 75 + 46 + 38 |
| `geologyLattice` (435,592 vertices, 863,492 triangles) | 460 |
| `bakeRelief` | 230 |
| albedos, contour channels, geometry, textures, material | about 670 |
| `chartHull` (emanation field) | 388 |
| `buildGeologyPreview` once the world is built | 1,364 |

The prototype's build, after the same `chartWorld`:

| Stage | ms |
| --- | --- |
| Coast segments | 1.6 |
| Coast bins (69,696 bins of 8 units; 3,395 list segments, 29 on average, 124 at most) | 75 |
| Landform records | 1.4 |
| All inputs, uploaded as textures (4.9 MB) | 84–107 |
| First bake of a level, pipelines compiling | about 2,300, once |
| Bake of one 1,024² level, height and derived passes, WebGPU | 1.3–2.4 |
| Bake of one level, WebGL 2 | under the 15 ms readback latency that measures it |

Frame cost, the GPU timestamp of one full frame through the post-process
pipeline at 2,560 × 1,600, each layer soloed, the same three views:

| View | Geology preview | Screen terrain |
| --- | --- | --- |
| Overview | 31 ms | 20 ms |
| Islands close | 30 ms | 20 ms |
| One island close | 25 ms | 20 ms |

These are a headless browser's numbers and only comparable with each
other. Memory on the GPU: the clipmap's two atlases, 6,144 × 1,024 texels
each, hold 101 MB (RG32F heights, RGBA16F derived values); the inputs
5 MB; the lattice it would replace holds about 40 MB of vertex attributes.

## Architecture

1. **The CPU keeps the decisions and a macro field.** Island placement and
   the preview's coasts (`chartWorld(data).islands`), each island's
   formation and the geometry it is built over (`chart.landforms`), each
   formation's derived constants and valleys (`sculpture`), the seafloor
   features, the platform, the hull, and the world field at 4 units as a
   low-frequency macro texture.
2. **The GPU bakes a camera-centred clipmap.** Six levels of 1,024² texels,
   each texel twice the map units of the level inside it: 0.25 units for
   the finest, which spans 256 map units, to 8 for the coarsest, which spans
   8,192, more than the whole sea. Each texel holds its elevation and owning
   island (RG32F), and a derived pass adds its gradient and its sun's
   visibility (RGBA16F). A level is baked by a full-screen pass into its own
   square of each atlas.
   - The macro field is read as a cubic B-spline, so no cell shows.
   - The coast is measured exactly from its segments: each 8-unit bin lists
     every segment a point inside it could find nearest, and the side is the
     parity of the crossings of a ray from the bin's corner, whose own side
     the CPU knows. Coasts are exact to the texel at any zoom.
   - Land is each island's landform, the very maths of `landforms.ts`,
     evaluated at the texel's own position from a record per island.
   - Across the coast the elevation is one straight ramp of the signed
     distance, so a cubic read places the waterline on the coast's true
     line between texels; within 2 map units out the seabed is at least an
     easing ramp, so the water deepens from nothing.
3. **Every pixel shades from the clipmap.** It reads the level its
   footprint asks for, the elevation, gradient and sun from a cubic
   B-spline over that level's texels, and draws everything else from them:
   the normal from the gradient, plates and contours analytically from the
   elevation's own contour coordinate on screen, cavity and curvature from
   the world grid's means against the pixel's own elevation, and the sun
   from the bake's horizon over the fine heights. The light, the land's
   surface, the water's optics and the emanation are the preview's own
   nodes (`terrainLightNode`, `landSurfaceNode`, `waterOpticsNode`,
   `oceanEmanationNode`); the plate term is a kernel tested against
   `plateShade`.
4. **The mesh only stands the surface up.** The camera is orthographic but
   tilted 40° by default, so escarpments must rise: a grid of 512 quads a
   side is laid over the view's ground, re-laid when the view has moved an
   eighth of it or zoomed by a quarter, and each vertex stands at the
   clipmap's elevation, read with the same spline the pixels use.

## Level choice, blending and re-bakes

`screen-terrain-clipmap.ts` holds the layout and its CPU twin of the
shader's choice. A pixel's continuous level is the larger of its
footprint's level, `log2(footprint / 0.25)`, the finest level baked for
the view, and the sum over levels of how far the pixel is into each one's
fade: 48 texels inside a level's edge, which itself stays 4 texels inside
the level's border. The sum is continuous everywhere, so levels hand over
without a seam. A level is read alone over the lower half of its octave,
its texel at most √2 of the pixel, and blends into the next coarser over
the upper half; the coarser one is read only while a pixel blends.

Each level's centre snaps to whole 64-texel steps of its own texel, so a
level's texel grid never swims under the view and a pan bakes nothing
until it crosses a snap. Each frame the layer bakes the levels from the
finest the view can read to the coarsest, but only those whose placement
or content (the world's key) changed since their last bake; finer levels
are left stale until a closer view asks for them. At the overview that is
two levels, close up all six. A full bake of a level costs about 2 ms on
WebGPU, so re-baking a whole level at a snap is affordable; toroidal
updates of only the exposed strip are a refinement for later.

## What moves to the GPU and what stays

| Work | Now | Screen terrain |
| --- | --- | --- |
| Preview coasts, lagoons' plans, landform choice and constants, valleys | CPU | CPU |
| Structural terrain, platform, seafloor features, terraces, detail | CPU, 4 units | CPU, 4 units, the macro field (later: terraces and detail on the GPU) |
| Signed distance to the coast | CPU raster, 4 units and 1 unit | GPU, exact from segments |
| Land elevation | CPU, 1-unit lattice | GPU, a texel down to 0.25 units |
| Seabed elevation | Lattice, bilinear in triangles | GPU, B-spline of the macro field |
| Normals | CPU, at vertices | GPU, per pixel from the spline |
| Cavity, curvature | CPU, at vertices | Per pixel against the grid's means |
| Sun shadow | CPU, on the 4-unit grid | GPU, over the fine heights |
| Albedo, plates, contours | CPU at vertices, 4-unit texture | Per pixel |
| Atolls' lagoons and inlets | CPU, carved into the landform | Read from the macro field for now |

## Parity: one implementation of the maths

The landform and noise maths are written once, over an abstract number
API (`terrain-kernel.ts`, `KernelMath`): every op a kernel uses is the
backend's, so the same function builds a JS value or a TSL node.

- `numberMath` runs on plain numbers. `terrain-kernel.test.ts` runs the
  kernels on it against `noise.ts` and `landformFor` and asks for exact
  equality: over every land cell of the reference chart (5,023 samples) the
  kernel matches `landformFor` to the bit.
- `float32Math` rounds every op to single precision, the GPU's arithmetic,
  so a test bounds the shader's error without a GPU: a mean of 1.7 × 10⁻⁷
  and at most 1.6 × 10⁻⁵ of full land.
- `nodeMath` (`terrain-kernel-tsl.ts`) is the TSL backend. A readback in
  the browser (WebGPU) compared 2,023 baked land texels more than a map
  unit from the coast, where the waterline's ramp leaves the landform as it
  is, with the CPU kernel at the same positions: a mean error of
  4.0 × 10⁻⁷, at most 6.4 × 10⁻⁶ of full land, and no texel on a different
  side of the coast or of a different island.

Seeds are 32-bit, so a record carries each as two exact 16-bit halves; the
hash runs on unsigned integers, whose multiply wraps as `Math.imul` does,
and a lattice point's floor is converted float to int to unsigned, which
keeps a negative column's bits on WGSL and GLSL alike (a bitcast would go
through float bits on GLSL, where a NaN payload is not safe). The CPU
packs records as plain numbers so the exact test holds; only the upload is
`Float32Array`. The kernel keeps each island's decisions on the CPU
(`sculpture` is exported from `landforms.ts` for its valleys) and copies a
few lines of each formation's constant derivations; the exact test catches
any drift. The plate term is the same pattern
(`terrain-kernel-plate.ts` against `plateShade`), and `coastDistance` is
the CPU twin of the shader's coast query, tested against brute force.

The end state is one copy: `landforms.ts`, `drainage.ts` and `noise.ts`
call their kernels on `numberMath` (see the migration).

## How the existing modules map onto it

| Module | Role |
| --- | --- |
| `chart-world.ts`, `world-terrain.ts` | The macro field and every decision; unchanged |
| `coasts.ts` | The preview's coasts, which become the bins' segments |
| `landforms.ts`, `drainage.ts`, `noise.ts` | The CPU originals of the kernels; `sculpture` exported |
| `lagoons.ts` | Still the CPU's; the bake keeps the grid's lagoon water inside a coast |
| `geology-lattice.ts`, `geology-relief.ts` | Replaced by the bake and the mesh |
| `contours.ts`, `contour-lines.ts` | Levels as before; the coordinate is computed per pixel, no texture |
| `geology-layer.ts` | Settings and the look, read as they are; the material ports its CPU-only pieces |
| `geology-land.ts`, `geology-light.ts`, `water-optics.ts`, `ocean-emanation.ts` | Reused as nodes, unchanged |
| `scene-composition.ts`, `scene.ts` | The hidden layer's id and its construction with the renderer |

New files: `screen-terrain-clipmap.ts`, `screen-terrain-coast.ts`,
`terrain-kernel.ts`, `terrain-kernel-noise.ts`, `terrain-kernel-landform.ts`,
`terrain-kernel-plate.ts` (pure, `src/lib/visualization`), and
`terrain-kernel-tsl.ts`, `screen-terrain-bake.ts`,
`screen-terrain-material.ts`, `screen-terrain-layer.ts` (`src/web/scene`).

## Migration, each step shippable

1. **The prototype, hidden.** Done: the "Screen terrain" layer, off in
   every preset, beside the geology preview.
2. **One copy of the maths.** `noise.ts`'s `gradientNoise` and `fbm`,
   `drainage`, and `landforms.ts`'s `sculpted` and formation reliefs call
   their kernels on `numberMath`; the parity tests become plain unit tests
   of the kernels. No visible change; it ends the risk of two copies.
3. **Lagoons as a kernel.** Port `lagoonLandform`'s water (`lagoonEdge`,
   `floorDepth`, the inlets' polylines, the reefs) with each lagoon's plan
   in a record; the bake stops reading lagoon water from the grid.
4. **Terraces and detail on the GPU.** Build the macro field from the
   seabed before the terrace pass (`featured`) and apply `terraceStep` per
   texel from the spline's gradient: risers exactly 12 units wide with
   crisp edges at any zoom, and the CPU world drops the pass. The detail
   pass (hills, gullies, fans) follows, or stays a 4-unit field added in.
5. **Sea stacks, the water's surface and the inspections** move onto the
   screen terrain (the stacks stand on the clipmap's elevation; inspections
   read the atlases).
6. **Make it the preview.** The geology layer builds the screen terrain;
   the lattice, `bakeRelief`, the contour texture and the albedo bake are
   deleted, and with them about 1.4 s of CPU a build.
7. **Refinements.** Toroidal level updates; a compute pass writing a
   storage texture on WebGPU, which also allows partial strips; levels
   sized to the canvas; fp16 heights relative to each level's mean to halve
   the atlases; finer seabed detail octaves for light alone.

Steps 2–4 each touch files other people are changing: step 2 rewrites the
insides of `landforms.ts`, `drainage.ts` and `noise.ts`, step 3 of
`lagoons.ts`, step 4 of `world-terrain.ts`'s terrace and detail passes.
Each should land after the concurrent work on those files has.

## Risks

- **WebGPU availability.** The bake is a full-screen render pass per level,
  not a compute pass, so it runs on WebGPU and on the WebGL 2 backend alike;
  both were checked in a GPU Chrome (WebGL 2 by hiding `navigator.gpu`).
  Render targets need RG32F and RGBA16F to be renderable, which WebGL 2
  has with `EXT_color_buffer_float`. Heights are read with `textureLoad`
  and filtered by hand, so `float32-filterable` is not needed. A software
  GL was not tried.
- **Precision.** Heights stay fp32: fp16 would band a tread's normals and
  wobble its contours. The kernels' single-precision error is bounded by
  test and measured on the GPU (above). Map coordinates up to a few
  thousand units divided by wavelengths of tens keep the noise's lattice
  coordinates in the low hundreds, well inside fp32.
- **Level seams.** The level is a continuous function of position, levels
  overlap by their fade, and a texel's height is the same function in every
  level, so seams are differences of sampling only; a 1-pixel ring
  appeared when the level was built with a `select` on the fade and went
  when it became a sum. Derived values near a level's edge read the next
  coarser level for the sun's horizon.
- **Mesh and pixels disagreeing.** With the camera tilted, the shading's
  map position is where the mesh is, so the mesh must stand on the same
  surface the pixels read; it reads the same spline.
- **TSL pitfalls met.** Chained `a.mix(b, t)` and `x.smoothstep(a, b)` take
  the receiver as the interpolant (`mix(b, t, a)`, `smoothstep(a, b, x)`):
  write `mix(a, b, t)` and `smoothstep(a, b, x)`. `If` needs a `Fn` around
  it. A value computed before a `branch` and read in it must be a variable
  (`KernelMath.keep`).

## What the prototype does not do yet

Atolls' lagoons and inlets come from the 4-unit grid; terraces and seabed
detail are the CPU's; sea stacks, the water's surface sheet and the
geology inspections are not drawn; a level is re-baked whole; the layer
stands in for the geology preview but does not hide it, so show one at a
time.
