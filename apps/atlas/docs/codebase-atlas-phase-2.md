# Paper, ink and relief

Phase 2 refines the accepted atlas materials without changing its geography.

## Fixed boundaries

- Preserve package and file coordinates, coastlines, shallows, hills and radius
  budgets from `c97f1964`. No layout, density or collision changes.
- Preserve the index, controls, fixed camera tilt, selection and reduced motion.
- Keep work inside the documentation app and atlas docs. No analyzer changes.

## Material direction

Matte mineral pigments on textured paper. Fine paper grain responds to light;
ink gathers along existing coastlines. Uniform raised land edges cast a soft
directional shadow onto the sea sheet. Elevation means paper thickness, never
quality, importance, activity or a newly inferred terrain metric.

Use generated material textures, not generated geographic noise. Keep shadows
and texture quiet enough that names, settlement marks and selected routes remain
readable. No animation at rest, orbit controls, glossy water or floating labels.

## Acceptance

Compare overview, Studio, UI, file zoom and a narrow viewport against the accepted
atlas. Verify the complete generated geography is unchanged. Check selection,
hover alignment, pan/zoom, reduced motion, WebGL errors and material disposal.
Texture detail should survive approach without making the whole map look dirty.
The browser comparison, not source checks alone, determines visual acceptance.

Zoom-dependent information, relocation of labels or files, snapshot continuity
and agent activity remain later phases. This pass does not fix the original
layout's spacing limitations.

## Implementation

Land relief is uniformly 3.2 map units. Matte paper uses a repeating deterministic
256-square grayscale bump texture; bump changes lighting, not vertex positions.
One directional light and neutral ambient fill light the paper. The static
shadow map is generated once, with no idle rendering loop. Coastal ink buildup
is clipped inside the existing boundaries. Color and ink use separate canvas
textures; annotations lie on one parallel plane above the raised paper so text
and routes remain continuous. The hit plane uses the same paper height.

The renderer releases both canvas textures, the grain texture, materials,
geometries and the light's shadow resources on disposal. Tests cover deterministic
grain and material disposal. A whole-survey comparison confirms accepted package
positions, file positions, radii and all contour arrays remain identical.

The implementation uses [Three.js bump mapping](https://threejs.org/docs/pages/MeshStandardMaterial.html),
not displacement mapping. Zoom-dependent label sizing and sharper close-up ink
remain Phase 3 concerns; the existing raster label scale is unchanged.

## Verification record

Eleven tests, typecheck and lint pass. Desktop overview, Studio, UI, db, isolated
documentation-app, file zoom and mobile captures preserve the accepted composition.
Browser checks cover neighborhood filtering, dependency navigation, file hover
alignment, pan/zoom/reset and reduced-motion settling without ongoing frames.
Independent review found no material rendering issue; user visual acceptance
remains separate. Existing close-up label crowding is not resolved by this pass.
