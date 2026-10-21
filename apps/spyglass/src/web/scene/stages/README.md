# Stages

The pass graph as a registry: `stages.ts` lists the stages in the order they
apply to the frame, and `scene/pipeline.ts`, the composer, walks the list. A
stage is one module exporting a `Stage` (`stage.ts`): an `id`, which is also
its view in the rendering sheet's "Show stage"; a `label` for that view;
`needs(settings, tier, context)`, whether the settings build it; `load()`,
its dynamic import, so the chart's first paint never waits for a stage; and
`apply(frame, inputs)`, which adds the stage to the graph, reading and
replacing `frame.color`, and returns the stage's own output, shown in place
of the finished image when its view is chosen. A stage that reads a scene
attachment beside the output and depth names it in `targets`, and the
composer renders it with the scene pass (`indirect.ts` reads the albedo).

The frame carries what the stages share: the camera, the scene, the depth,
the tier's quality table, the settings, the uniforms the settings drive,
`selection`, the one array of selected objects the composer refills before
each render, and `nodes`, where a stage pushes what it made that owns a
render target, released with the graph. There is no normal: the display
nodes read theirs from the depth, and `stage.ts` wraps their calls once
(`aoFromDepth`, `denoiseFromDepth`, `ssgiFromDepth`) so no stage casts the
absence itself. A normal target would also collect the translucent props,
which never write depth, and make them occlude the surface beneath.

A stage owns the conversion from the reader's settings to its uniforms: the
occlusion stage exports `occlusionStrength` (the slider as an exponent on
the raw term) and `occlusionReach` (pixels at the point of interest to world
units, each frame), which the composer calls by name from its `configure`
and `render`. The tone mapping stays in the graph's rebuild signature, and
the depth view is the composer's own.

The stages, in order: `occlusion.ts` (screen-space occlusion from the depth,
multiplied in), `indirect.ts` (screen-space indirect light, for the
perspective wreck dives), `outline.ts` (the selection glow: the selected
island's terrain outlined and added in the ladder's glow ink), `bloom.ts`
(a glow from the brightest ink, which lifts the selection glow), and
`display.ts` (id `final`), last and always built: exposure, tone mapping,
the sRGB transfer, saturation and vibrance.

## Adding a stage

Add its id to `RenderStage` in `settings/chart-settings.ts`, write the module
here, and add it to the list in `stages.ts` where it belongs in the order.
The composer rebuilds the graph when any stage's `needs` changes, so a toggle
belongs in `RenderSettings` and a slider in the uniforms; the sheet's "Show
stage" lists the registry's ids and labels (`renderStages`) plus the depth,
so the new stage's view appears with it. The composition `describe()` on the
scene handle lists the stage and whether the graph holds it.
