# Shader library

Reusable WGSL modules for the prototypes in `src/gpu/`. Import them
relatively from an entry shader:

```wgsl
import { gradientNoise } from "../../shaders/noise/gradient.wgsl";
```

## Rules

- **Modules are pure.** No `@group/@binding` here: vgpu's resolver rejects
  resources in imported modules. Anything a function needs (uniforms,
  textures, the noise origin) arrives as a parameter, and the entry shader
  owns the bindings.
- **Every module validates on its own:**
  `node_modules/.bin/vgpu check src/shaders/<path>.wgsl --require-validation`
  (the pre-commit hook runs it on staged `.wgsl` files).
- **Large coordinates never reach f32.** Noise takes a `LatticeOrigin` (split
  in f64 on the CPU by `noise/lattice.ts`) plus a small offset. Heightfields
  take a surface offset from `geometry/sphere.wgsl`. That's what keeps
  detail exact down to ~1e-9 of the planet radius.
- A module's CPU counterpart (packing, constants) sits next to it as `.ts`.

## Index

### noise/

| Module | Exports | What it is |
| --- | --- | --- |
| `lattice.wgsl` | `LatticeOrigin`, `Lattice`, `latticeAt`, `latticeHash`, `FINEST_OCTAVE` | Seeded integer lattices for octaves 0–29, all derived exactly from one origin at 2^29 |
| `lattice.ts` | `latticeOrigin`, `writeLatticeOrigin`, `LATTICE_ORIGIN_BYTES` | CPU side: a point's origin, split in f64 |
| `gradient.wgsl` | `gradientNoise` | Perlin gradient noise, quintic fade, ~[-1, 1] |
| `voronoi.wgsl` | `Voronoi`, `voronoiNoise` | Cellular noise: F1, F2, and a stable cell id |
| `planar.wgsl` | `planarHash`, `planarHash2`, `planarNoise`, `planarFbm`, `planarRidged` | Seeded 2D noise for flat maps a few thousand units across: no lattice origin, PCG-hashed gradients, turned octaves |

### terrain/ (procedural geometry)

| Module | Exports | What it is |
| --- | --- | --- |
| `layers.wgsl` | `TerrainParams`, `Base`, `Detail`, `DetailTail`, `baseLayers`, `detailOctaves`, `detailTail`, `warpAt`, `lodWeight`, `MAX_HEIGHT`, `OCTAVES`, `DETAIL_FIRST`, `DETAIL_AMPLITUDE` | The planet's height field. Base layers: warp → Perlin continents → ridged mountains → Voronoi plateaus → warped rivers. Then LOD detail octaves: hybrid ridged/billow fBm whose count follows the footprint, with early out and slack bounds. `detailTail` evaluates the same octaves past a prefix already summed at a coarser footprint (a clipmap texel), resuming the warp chain |
| `fit.wgsl` | `fitBase`, `fittedBase`, `FIT_STEP` | Second-order fit of the base layers around an origin, for samples closer than f32 can resolve them |
| `clipmap.wgsl` | `Clip`, `clipChart`, `clipOffset`, `clipLevel`, `clipTexel`, `clipTexelCoord`, `clipTexelCenter`, `catmullRom`, `CLIP_SIZE`, `CLIP_LEVELS`, `CLIP_REACH` | Nested camera-centred levels on a gnomonic chart of the sphere: chart ↔ surface offset, which level holds a sample at a footprint, Catmull-Rom weights. Texture loads stay in the entry shader |
| `palette.wgsl` | `groundColor`, `waterColor` | Elevation bands, slope rock, snow, river banks, and the sea |
| `shaping.wgsl` | `smoothMax`, `smoothMin`, `terrace`, `softTerrace` | Polynomial smooth unions; a staircase with riser width and tread tilt; and a step whose hardness runs from a smoothed-over ramp (0) to a cliff (1), varying per step while staying continuous |
| `rock.wgsl` | `rockFlutes`, `rockBeds`, `stratifiedRock` | Cliff rock for heightfields: grooves down the fall line (four fixed frames blended by alignment, so they never shear on curved cliffs), horizontal beds with seams, a dark foot and pale crown. Takes a tileable noise texture; every term fades before it aliases |

Noise salts in use, by layer: 11–16 warp, 21–25 continents, 30 mountain belt,
43–48 ridged, 50 Voronoi, 60 river, 109–129 detail, 198–199 coarse tint,
209–229 detail tint, 300–304 paper and pigment, 400–549 the Spyglass
archipelago (520–539 its shape passes, 540–549 its rock, banding and ledge specks,
550–579 its scatter layers (550–558 vegetation candidates and groves, 560–568
debris candidates and reefs), 580–587 its cumulus billows and wisps, 589 its
finish, 600 and 602 its foundation rings' edges, 603 the deep's rings), the
Islands sea's flow map hashes nothing, 720–722 the Islands platform's lobes, 723–725
its notches, 726–728 its banks' wandering edges, 729 its deep rings'
spacing, 730–732 their wandering edges and 733–735 the levels' undulation
(`gpu/islands/shaders/sea/bathymetry.wgsl`), 760–761 its caustics, 770–778 its
surf, cliff wash and swash (`sea/shore.wgsl`), 780–781
its sand ripples and 790–791 its specks (`sea/surface.wgsl`,
`sea/sand.wgsl`), 800–807 its props' candidates, patches and shapes
(`gpu/islands/shaders/land/debris/`), 810–816 its turf's patches, clumps, tufts, blades
and hummocks and 819–823 its wind's gusts, squalls, flutter and combing (`land/grass.wgsl`) and 829–832 its town's walls, roof tiles, hedges and seats (`world/town.wgsl`), and 860–869 its foliage's candidates, copses, tints, planned trees and leaves (`world/foliage-scatter.wgsl`, `world/foliage.wgsl`), and 870–872 its structures' blind windows, curtains and board shades (`world/town.wgsl`), and 850–859 its surfaces' asphalt, gravel, paving, crops, soil, path edges, lots, lawns and sand (`world/surfaces.wgsl`). Shared modules that hash take
their salt from the caller. Pick new salts outside these, or a layer will repeat
another's pattern.

### geometry/

| Module | Exports | What it is |
| --- | --- | --- |
| `sphere.wgsl` | `raySphere`, `altitudeDelta`, `surfaceOffset` | Ray/sphere span; radial altitude change and projection onto the unit sphere, both rearranged so nothing large cancels |
| `latlng.wgsl` | `latLngToDirection`, `directionToLatLng`, `equirectUv` | Latitude/longitude ↔ direction in one body frame (+y north, +x at 0°/0°, 90°E at −z: east is right from outside), and equirectangular map uv (180°W, 90°N at 0, 0) |
| `latlng.ts` | `latLngToDirection`, `directionToLatLng` | CPU side in f64 and degrees, as h3-js and gazetteers use them |
| `icosphere.wgsl` | `icosphereCorner`, `ICOSPHERE_VERTICES_0`, `ICOSPHERE_VERTICES_1` | A unit icosphere from the vertex index (level 0: 20 faces, level 1: 80), for instanced props drawn without a vertex buffer |

### scatter/

| Module | Exports | What it is |
| --- | --- | --- |
| `scatter.wgsl` | `ScatterCandidate`, `scatterCandidate`, `scatterKeep`, `scatterClumps`, `scatterFrame`, `scatterPixels`, `scatterFade` | Procedural placement from baked maps: one jittered candidate per grid cell (jitter below 1 keeps neighbours apart), thinning by a density with per-cell rolls (stable: a higher density keeps a superset), clumping from a noise value, a frame standing a prop on a ground normal and turning it, and a projected pixel radius and fade for LOD. Takes six salts from the caller's |

### post/

| Module | Exports | What it is |
| --- | --- | --- |
| `bloom.wgsl` | `bloomPrefilter`, `bloomDownsample`, `bloomUpsample`, `bloomScreen` | A bloom chain's pieces: a soft-knee bright-pass, a 13-tap downsample that keeps lone bright pixels from flickering, a 9-tap tent upsample of any radius, and a screen blend that never clips. Textures and samplers come from the entry shader (see `gpu/spyglass/shaders/bloom.wgsl`) |
| `fxaa.wgsl` | `fxaa` | FXAA (Lottes' console variant): an edge from the four diagonal neighbours' luma, a blur along it and never across, the shorter blur kept where the longer strays outside the neighbourhood; flat areas left sharp. Reads a display-referred image; the entry shader owns the texture (see `gpu/islands/shaders/post/antialias.wgsl`) |
| `kuwahara.wgsl` | `sobelTensor`, `blur5`, `Flow`, `tensorFlow`, `Kernel`, `kuwaharaKernel`, `kernelOffset`, `kernelDisc`, `SectorShape`, `sectorShape`, `Sectors`, `addSample`, `sectorColor` | Anisotropic Kuwahara filtering (Kyprianidis 2009/2010): the structure tensor of an image and its flow (edge direction and anisotropy), an elliptical kernel walked in its own frame, and eight polynomial-weighted sectors whose means are weighted by inverse variance, so the image flattens into painted regions with crisp edges. The entry shader owns the textures and the tap loop (see `gpu/spyglass/shaders/brush.wgsl`) |

### camera/, sky/, debug/

| Module | Exports | What it is |
| --- | --- | --- |
| `camera/ray.wgsl` | `cameraRay` | Pinhole ray through a screen uv |
| `sky/atmosphere.wgsl` | `atmosphere`, `toDisplay` | Exponential-shell atmosphere, eight samples; Reinhard + gamma |
| `sky/cumulus.wgsl` | `cumulusProfile`, `cumulusPhase`, `cumulusSunlight` | Heightfield cumulus: density in a column with a flat base and rounded top, a two-lobe phase, and Beer-powder sunlight, for marching a cloud layer read from baked 2D noise |
| `debug/heat.wgsl` | `heat` | The step-count ramp (black, red, yellow, white) behind every `steps` view |

### water/

| Module | Exports | What it is |
| --- | --- | --- |
| `waves.wgsl` | `sampleWaves` | Directional wave height, slopes, and vertical velocity from a caller-owned spectrum |
| `waves.ts` | `WATER_WAVES`, `sampleWater` | Shared spectrum and matching CPU sampler for buoyancy and picking |

### illustration/

| Module | Exports | What it is |
| --- | --- | --- |
| `paper.wgsl` | `paperGrain`, `washDensity` | Stationary, footprint-filtered paper fibers and low-frequency pigment variation |

## Who uses what

| Prototype | Imports |
| --- | --- |
| `/terrain` (`gpu/terrain/terrain.wgsl`) | noise via layers, terrain/* (clipmap included), geometry, camera, sky, debug |
| `/terrain`, virtual mode (`gpu/virtual/bake.wgsl`) | terrain/layers, terrain/fit, geometry |
| `/terrain`, virtual mode (`gpu/virtual/march.wgsl`) | geometry, camera, sky, debug, terrain/palette |
| `/planet` (`gpu/planet/*.wgsl`) | geometry (`raySphere`), debug (`heat`), simplex noise |
| `/moon` (`gpu/moon/moon.wgsl`, `grid.wgsl`) | geometry (sphere, latlng), camera, debug |
| `/pond` (`gpu/pond/pond.wgsl`) | water (shared with four-point hull buoyancy), illustration/paper |
| `/spyglass` (`gpu/spyglass/shaders/*.wgsl`) | noise/planar, terrain/shaping, terrain/rock, sky/cumulus, illustration/paper, scatter, geometry/icosphere, post/bloom, post/kuwahara |
| `/islands` (`gpu/islands/shaders/`: `land/*.wgsl`, `land/debris/*.wgsl`, `sea/*.wgsl`, `maps/*.wgsl`, `world/*.wgsl`, `view/*.wgsl`, `scene/*.wgsl`, `post/*.wgsl`) | post/bloom and post/fxaa (the post), scatter and geometry/icosphere (the props on the shallows), noise/planar (the surf, the caustics, the sand, the banks' wander), terrain/shaping (`smoothMin` for the banks' plates and hull); its sea surface (`sea/surface.wgsl`) computes the water/waves field as slopes in its own module, from `water/waves.ts`'s spectrum at the chart's scale |
