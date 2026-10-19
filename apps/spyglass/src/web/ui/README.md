# Chart controls

The UI keeps the compass upright in screen space. It is not a scene mark and
has no canvas hit target. A narrow app bar extends left from its vertical
centre. Zoom, overview and development FPS stay visible
there without opening settings. Entries grow the bar until it reaches the
viewport edge, then the bar scrolls horizontally. The bottom bar holds the reading mode switch and opens the introduction and
legend sheets. The compass opens the settings sidebar.
Both use the chart's paper and brass styling. Opening motion is unchanged.

The labels' `frame-border.ts` follows the visible coordinates with an inset gold
SVG lining. The rule splits equally around each run, enclosing it without a
fill, and rejoins at pointed ends. The top and left openings share a square
corner when both reach it. `layout/chart-frame.ts` calculates the paths.
The border ignores pointer events and is hidden from assistive technology.
Grid references use full-height 12px type; place names retain the chart tilt.

`chrome-entries.tsx` declares two registries: `appBarEntries` for immediate
navigation and status, and `chromeEntries` for sidebar settings. The bottom
bar owns reading mode and legend access. Each supplies a stable id
and component; sidebar entries also supply a title and description. Add an
entry to the appropriate registry to extend the UI. Components receive the
current viewer state and actions. App-bar components also receive `onOpen`
for opening settings. Sidebar entries become keyboard-accessible tabs. Only the selected tab mounts
while open, so switching away stops diagnostic polling. Global actions sit
above the tabs and remain available in every category.

Development tools and the app-bar counter are separate lazy entries behind
Vite's `import.meta.env.DEV`. Their controls, FPS observer and stylesheet are excluded from production builds. The FPS
readout counts actual map submits via existing performance measures. It does
not request animation frames or keep an idle scene running.

`use-sheet.ts` owns Escape, dismissal and focus restoration. Bottom sheets
are modal and contain focus. The settings sidebar is modeless, so map and
app-bar controls stay usable while it is open. The bottom sheet's
`SheetHandle` supports dragging down to dismiss, snapping back after a short or cancelled drag, and keyboard
activation. The sidebar uses a close button and has no drag handle.

Controls are native HTML inputs styled through `settings-controls.tsx` and its
stylesheet. Labels, hit areas, focus and disabled states follow one treatment.
`SettingsRange` updates color uniforms live; layout ranges use
`commitOnRelease` so dragging previews a number and release commits one change.
The shared scene-ready state enables an already-open panel when scene startup
finishes. Composition and renderer polling mount only in their selected tabs.
Effect controls disable unavailable dependencies and unavailable stage previews;
switching off a previewed effect returns to the final image.
