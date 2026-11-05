# Documentation layout and annotations

Blume owns the Astro shell, navigation, search, theme, heading anchors, outline,
and pagination. `components.ts` registers `reading-tools.astro` in `PageHeader`
and `annotation-layer.astro` in `PageFooter`. No generated `.blume` files are
edited. The custom home page keeps its separate Blume `PageLayout`.

The article keeps the gray theme and Inter / IBM Plex Mono fonts configured in
`blume.config.ts`. `styles/reading.css` sets a 70ch maximum measure, 1.75 line
height, and extra separation before second-level headings. Reading mode hides
the desktop navigation and outline at 64rem and above. Its checkbox remains
page-local. Mobile keeps Blume's drawer and collapsible outline.

## Annotation tools

This is a small SVG editor inspired by Excalidraw, not an embedded Excalidraw
instance or its file format. Browse leaves links, selection, and page scrolling
available. Draw and Add text explicitly enable hit testing over the article.
A compact icon rail stays at the right center at desktop and mobile widths.
Accessible tool names and hover/focus tooltips label the icons.
The editor supplies freehand strokes, multiline text, ink color, undo, and clear.
Undo restores up to 20 changes in the current page session, including clear.
There is no selection, moving, or editing an existing note in this first slice.

Handwritten notes and the note entry form use Comic Neue, with Comic
Sans and Chalkboard fallbacks. Comic Neue Regular is self-hosted from
[google/fonts](https://github.com/google/fonts/tree/main/ofl/comicneue).
Its license ships alongside the font in `public/fonts/ComicNeue-OFL.txt`.
The underlying docs keep their existing typography.

For keyboard text placement, activate Add text and press Enter on the focused
drawing area. The note form opens in the visible part of the article. Escape
from annotation work returns to Browse. Escape in unrelated controls remains
owned by those controls. Freehand drawing requires a pointer.

## State boundary

`model.ts` defines a versioned document of marks. `storage.ts` owns validation,
JSON encoding/decoding, and localStorage. `mount.ts` owns the Astro lifecycle and
passes an initial document plus an onChange callback into `mountEditor`.
The editor renders this document and delegates anchor resolution to `anchors.ts`.
It does not read storage or the URL. This boundary permits a later URL transport
without coupling the drawing tools to it.

Storage keys use normalized pathname, ignoring query and fragment. Notes survive
reload and navigation in the same browser and origin, and remain separate on
different pages. They are not shared with another browser or person. A copied
page link contains no annotations. Storage failures are shown beside the tools
and in the footer; they do not falsely claim a save. Browser storage is the
only durable copy in this version, so clearing it removes the notes.

The decoder rejects malformed data, unsupported versions, duplicate IDs,
nonfinite coordinates, invalid colors, and oversized documents. Limits are
300 marks, 2,000 points per stroke, and 2,000 characters per note.
Astro before-swap disposes listeners, observers, and the old host; page-load
creates one fresh editor for the new article.

## Element attachment and responsive behavior

Each mark has a block ID and normalized x/y coordinates inside that block.
Blocks include headings, paragraphs, code, table, list items, and figures.
IDs combine section heading, tag, normalized content hash, and duplicate
occurrence. Unchanged blocks survive unrelated paragraph insertion. Changing
or removing a target leaves the saved mark unresolved and hidden instead of
silently attaching it to different content. Identical duplicate blocks and
renamed heading IDs can still invalidate or confuse identity. Explicit authored
annotation IDs are the next step for content that changes frequently.

Anchor origins resolve against live element rectangles after reflow, reading
mode changes, font loading, and resize. Text wraps and its display position is
clamped to the article width. Stroke offsets retain their authored shape in
storage. Rendering scales a stroke uniformly when it is wider than the current
column and clamps it horizontally inside the column. Wider layouts restore its
original size. These display adjustments do not rewrite saved coordinates.

A mark follows its block rather than a particular character or word. A drawing
spanning several paragraphs cannot track each paragraph independently. Annotation
text can cover the prose beneath it, as expected for a transparent drawing layer.
The narrow side rail can cover a small strip of content on mobile. Fine
text-range anchors, movable notes, and a collapsible toolbar are future work.

Tool controls disappear in print; rendered saved marks remain visible.

## Sequence and validation

The shared layout and annotation state now precede the illustration phase in
`chronicles/interactive-documentation/plan.md`. Next, settle durable authored
anchors and interaction details before adding shareable URL state and concept
illustrations. No URL encoding or server persistence is implemented here.

The first implementation was exercised in the T3 browser at 1440px and 390px:
text placement including keyboard placement, reload, clear/undo, page isolation,
client navigation/back, reading-mode reflow, and search Escape focus. A click
stroke and browser-dispatched pointer-event sequences exercised SVG persistence
and a 500px stroke fitting a narrow column. T3's native drag action timed out,
so continuous trusted-pointer dragging is not claimed as verified.
Storage/anchor/geometry tests cover malformed data, limits, storage failures,
responsive resolution, content changes, and stroke fitting.

Astro references:

- https://docs.astro.build/en/basics/layouts/
- https://starlight.astro.build/uk/reference/overrides/
