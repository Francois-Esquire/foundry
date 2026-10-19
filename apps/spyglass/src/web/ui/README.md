# Chart controls

The UI keeps the compass upright in screen space. It is not a scene mark and
has no canvas hit target. A narrow app bar extends left from its vertical
centre. Zoom, overview, map-mode switching and development FPS stay visible
there without opening settings. Entries grow the bar until it reaches the
viewport edge, then the bar scrolls horizontally. The bottom bar opens the
introduction and legend sheets; its Rendering button and the compass open the same controls sidebar.
Both use the chart's paper and brass styling. Opening motion is unchanged.

`chrome-entries.tsx` declares two registries: `appBarEntries` for immediate
controls, and `chromeEntries` for sidebar settings. Each supplies a stable id
and component; sidebar entries also supply a title and description. Add an
entry to the appropriate registry to extend the UI. Components receive the
current viewer state and actions. App-bar components also receive `onOpen`
for opening settings. Sidebar content is flat, mounted only while open, so
closing it stops diagnostic polling.

Development tools and the app-bar counter are separate lazy entries behind
Vite's `import.meta.env.DEV`. Their controls, FPS observer and stylesheet are excluded from production builds. The FPS
readout counts actual map submits via existing performance measures. It does
not request animation frames or keep an idle scene running.

`use-sheet.ts` owns Escape, dismissal and focus restoration. Bottom sheets
are modal and contain focus. The settings sidebar is modeless, so map and
app-bar controls stay usable while it is open. The bottom sheet's
`SheetHandle` supports dragging down to dismiss, snapping back after a short or cancelled drag, and keyboard
activation. The sidebar uses a close button and has no drag handle.
