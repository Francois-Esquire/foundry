# Chart controls

The UI keeps the compass upright in screen space. It is not a scene mark and
has no canvas hit target. A narrow app bar extends left from its vertical
centre. Zoom, overview and development FPS stay visible
there without opening settings. The Labels and Ruler buttons show the layer
groups `detailToggles` names in `settings/scene-composition.ts`; each group
starts hidden in the default composition. Entries grow the bar until it reaches the
viewport edge, then the bar scrolls horizontally. The bottom bar opens the
introduction and legend sheets. The compass opens the settings sidebar.
Both use the chart's paper and brass styling. Opening motion is unchanged.

`ChartCoordinates` follows the chart's outer coordinate limits with an inset gold
SVG lining. The rule splits equally around each run and rejoins at pointed ends. The
enclosures use the UI parchment fill; an SVG luminance mask cuts the coordinate glyphs
out so the map shows through them. The row and column touch the right and bottom points of a persistent hollow
diamond corner. The corner has no fill or backing plate. End finials leave a gap
before the bottom and right corners. Disconnected starts carry matching diamond
finials with the same clearance. Clipping or hiding an individual label
does not move a V. Limits outside the viewport pin their V to the inset edge;
when a limit comes into view, its V follows it inward and leaves a single rule
beyond it. `ui/chart-frame-layout.ts` calculates the paths.
The border ignores pointer events and is hidden from assistive technology.
The cast area shares the UI parchment color, with a brass edge and a clipped
inset highlight for a shallow bevel.
Grid references use full-height 12px SpyglassDisplay type, matching the wordmark;
a fine brass outline makes their transparent centers legible. Place names retain the chart tilt. Coordinate furniture sits above map labels
and does not suppress letters or numbers when their positions overlap.

`chrome-entries.tsx` declares two registries: `appBarEntries` for immediate
navigation and status, and `chromeEntries` for sidebar settings. The bottom
bar owns legend access. Each supplies a stable id
and component; sidebar entries also supply a title and description. Add an
entry to the appropriate registry to extend the UI. Components receive the
current viewer state and actions. App-bar components also receive `onOpen`
for opening settings. Sidebar entries become keyboard-accessible tabs. Only the selected tab mounts
while open, so switching away stops diagnostic polling. Global actions sit
above the tabs and remain available in every category.

Development tools and the app-bar counter are separate lazy entries behind
Vite's `import.meta.env.DEV`. Their controls, FPS observer and stylesheet are excluded from production builds. The FPS
readout counts the frames Islands submits, through the `spyglass:render-submit`
measures `ui/islands-map.tsx` records from each `frame` event. It does not
request animation frames or keep an idle map drawing.

`use-sheet.ts` owns Escape, dismissal and focus restoration. Bottom sheets
are modal and contain focus. The settings sidebar is modeless, so map and
app-bar controls stay usable while it is open. The bottom sheet's
`SheetHandle` supports dragging down to dismiss, snapping back after a short or cancelled drag, and keyboard
activation. The sidebar uses a close button and has no drag handle.

Controls are native HTML inputs styled through `settings-controls.tsx` and its
stylesheet. Labels, hit areas, focus and disabled states follow one treatment.
The shared ready state (`sceneReady`, set on Islands' first frame) enables an
already-open panel when the map starts. Status and composition polling mount
only in the development Stats tab.

`settings/scene-composition.ts` names the layers the viewer lays over the map:
the labels, the chart frame, the coordinates, the latitude scale and the sea
caption. `composition.hidden` stores visibility choices; a nonempty
`composition.solo` temporarily overrides them. The DOM labels and the chart
chrome read this same composition. Islands draws everything beneath them and
has no such switches here.

## Map presentation boundary

`IslandsMap` (`islands-map.tsx`) owns three separate hosts: the WebGPU canvas
Islands draws on, the accessible map labels, and React chart chrome. It reaches
the renderer only through `islands-host/islands-api.ts`, and works out what the
labels read from Islands' API (`islands-host/map-view.ts`): the view
(`InkView`) from its camera and `pixelsPerUnit`, read for scale, and each
label's place from `project` on the land's height (`heightAt`, sea level on
the water). Which labels fit, clear the controls and clear each other is
decided on screen from those projections, since the perspective camera shows
the far side smaller than the near. It repaints
the labels and the chrome on each frame Islands draws and on each state change,
since a still chart draws no frames. `map-labels/` owns DOM reconciliation,
text measurement and keyboard activation.

Selection is the viewer's: a click in Islands arrives as its `select` event and
is written to the snapshot; the snapshot's selection reaches Islands through
`select` (a file as its module), and the camera frames it through `frame`,
jumping instead of flying under reduced motion. A ring Islands chooses has no
selection in the viewer: it clears the snapshot's, and Islands keeps the ring
until the snapshot selects something or Escape lets it go. The camera stands
at the reader's elevation (Chart settings) from the moment Islands fits the
chart, and moves with it. Escape anywhere outside an open
dialog returns to the overview (`home`, which frames the whole chart); Islands'
own keys listen on the canvas once it has focus. The camera is held north-up.

`chart-chrome-model.ts` prepares immutable screen-space props for
`ChartChrome` and `ChartCoordinates`: the cast areas, coordinate lettering,
latitude scale and sea caption. Unchanged presentation inputs publish no
React update. `chart-frame-layout.ts` and `chart-margin-layout.ts` contain
their geometry. Presentation DOM, CSS and text measurement belong here; the
GPU belongs to Islands, and the layer check keeps every import of
`src/web/islands/` inside `islands-host/islands-api.ts`.

Labels and chart chrome have separate frame updates so either can be isolated.
The text-measurement host remains outside the hideable label section: chrome
still needs nonzero font measurements while labels are hidden. Hidden labels
publish no hit boxes and are inert until restored.
