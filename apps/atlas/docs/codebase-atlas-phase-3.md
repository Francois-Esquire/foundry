# Exploration at each scale

Phase 3 is implemented over the accepted geography and Phase 2 materials. Work stays in
the documentation app and atlas docs. No analyzer edits, layout forces or new
terrain metrics.

## Journey

Choose an island, approach a computed neighborhood, inspect a file and follow
one of its recorded imports. Return to the enclosing island or whole atlas.
The searchable index remains the keyboard equivalent of map navigation.

## Representation

Visible ink repaints at viewport resolution as the camera moves. Lettering stays
in the tilted map plane with bounded sizes and collision suppression. Package
names lead at overview. Neighborhood labels require a selected territory and
0.8 CSS pixels per map unit; ordinary file names require 2.5. The selected file
label takes priority at any scale. Crowded labels may remain hidden, with all
files and groups available in the index.

Selecting a neighborhood frames its existing members and emphasizes their
settlements by dimming other files in the same territory. It never repacks them.
Direct file relationships come from the
existing module edges, not inferred proximity. File connections in the margin
lists Imports and Imported by, with navigation to each source or target's actual
settlement. Return controls lead to the enclosing island or whole atlas.

## Verification

The documentation package's 14 tests, typecheck, lint, format check and build
passed. Geometry comparison against the original algorithm found unchanged coordinates and
contours for the current survey. Desktop and mobile browser checks covered
overview, island, neighborhood and file states, index selection, hover alignment,
zoom, reset and reduced motion. Review of nine screenshots found no material UI issue.

Keyboard navigation followed Studio's `roadmap-view-adapter.ts` import to
`packages/db/src/models/index.ts`, then returned to db and the overview. The
destination and hover alignment matched. Reduced-motion rendering remained
unchanged across a 400ms check after settling.

Historical continuity and agent events remain Phases 4 and 5. This phase does
not promise clearance between the original settlement positions.
