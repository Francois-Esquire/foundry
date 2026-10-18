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

The frame carries what the stages share: the camera, the depth, the null
normal (read from depth), the tier's quality table, the settings, the
uniforms the settings drive, and `nodes`, where a stage pushes what it made
that owns a render target, released with the graph. The display stage
(`display.ts`, id `final`) is last and always built: exposure, tone mapping,
the sRGB transfer, saturation and vibrance.

## Adding a stage

Add its id to `RenderStage` in `settings/chart-settings.ts`, write the module
here, and add it to the list in `stages.ts` where it belongs in the order.
The composer rebuilds the graph when any stage's `needs` changes, so a toggle
belongs in `RenderSettings` and a slider in the uniforms; the sheet's "Show
stage" lists the registry's ids and labels (`renderStages`) plus the depth,
so the new stage's view appears with it. The composition `describe()` on the
scene handle lists the stage and whether the graph holds it.
