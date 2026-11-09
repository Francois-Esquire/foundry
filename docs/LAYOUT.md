# Documentation layout and annotations

Blume owns the Astro shell, navigation, search, theme, heading anchors, outline,
and pagination. `components.ts` registers `reading-tools.astro` in `PageHeader`
and `annotation-layer.astro` in `PageFooter`. The custom home page retains
Blume's separate `PageLayout`. No generated `.blume` files are edited.

The article keeps Blume's gray theme, Inter / IBM Plex Mono typography, a 70ch
maximum measure, and 1.75 line height. Reading mode hides desktop navigation and
outline at 64rem and above. Mobile retains the existing drawer and outline.

## Tools and selection

This is a small SVG annotation editor inspired by Excalidraw. It does not embed
Excalidraw, alter the source prose, or use Excalidraw's file format. The primary
rail stays on the right at every width. It contains visibility, Browse, Draw,
Add text, ink color, Undo, Share, and the annotation menu. Controls have accessible
names, hover/focus tooltips, and 44px targets. Short landscape rails scroll.
Narrow layouts reserve a gutter so the rail does not cover the reading column.

Browse permits normal links, selection, and scrolling. Selecting text offers
Highlight, Underline, and Comment in a contextual menu. Those actions and Arrow
are also in the annotation menu. A selection may include inline emphasis,
links, code, or several paragraphs. Selected-text tools wait for the selection
to finish rather than capturing partial text while a drag is in progress.

- Highlights cover each current line of selected text.
- Underlines redraw under each current line with a small curved ink stroke.
- Comments attach to text and open an editable note from a marker or the menu.
- Arrows attach their tip to a nearby word or a selected text target. Without a
  confident text match, the arrow remains attached to its block.
- Draw keeps a local freehand sketch. A sufficiently horizontal gesture near
  text offers a quote preview and an explicit Attach underline / Keep sketch
  choice. It never silently changes an ordinary drawing into text markup.
- Add text creates a free-positioned handwritten note attached to its block.

Handwritten notes use self-hosted Comic Neue Regular, with Comic Sans and
Chalkboard fallbacks. The note-entry form uses the same font. Tool chrome remains
sans serif. Font source and license are in
[google/fonts](https://github.com/google/fonts/tree/main/ofl/comicneue) and
`public/fonts/ComicNeue-OFL.txt`. Dark mode lightens rendered ink and adjusts
highlight opacity; saved color values remain unchanged.

## Editing and visibility

The annotation menu lists marks, including unresolved attachments. Notes can be
edited. Every mark can be deleted, and unresolved marks can be reattached to a
new text selection, including legacy block-attached sketches and notes. Clear
is a secondary action. Undo restores up to 20 changes in the current session.
The editor retains a typed note draft if the 300-mark limit rejects its save.

The eye hides all marks and editing controls, leaving the eye available to show
them again. It does not call the persistence callback, clear local storage, or
change the URL. Visibility is a local page-view preference, not shared state.
While hidden, mobile text reclaims the gutter. Reloading defaults to visible.

For keyboard note placement, activate Add text, then press Enter on the focused
drawing area. The form appears in the visible viewport. Escape closes an
annotation panel or returns an active tool to Browse, without stealing Escape
from the site's search or navigation. Freehand drawing requires a pointer.
Tool controls disappear in print; visible marks remain rendered.

## Text and block attachment

A text target is a sequence of segments. Each segment stores its block identity,
UTF-16 start/end offsets, exact quote, and prefix/suffix context. `text-anchors.ts`
resolves that meaning through DOM text nodes and browser Ranges without wrapping
or changing the prose. Adjacent inline rectangles merge per visual line so an
emphasized word does not receive duplicate highlight opacity.

When text wraps, current line rectangles determine display geometry. Resize,
reading-mode changes, and font loading trigger redraws. Color/theme changes
update rendering too. Highlights and underlines follow all current lines; arrow
heads retain their size, and comment markers avoid the rail.

Resolution first checks the stored offsets and quote, then attempts an exact
quote/context recovery. A recovered match needs its stored prefix and suffix on
both sides; an empty side means the quote touched its block boundary, so the
match must too. A bare quote match without that context is accepted only inside
its original block, so a single word that now appears in an unrelated paragraph
is not taken as the target. Ambiguous or missing targets remain saved and
unresolved, with an indicator in the annotation menu. A user can select
replacement text and choose Reattach. The editor never guesses between
identical matching passages.

Block IDs combine section heading, tag, normalized content hash, and duplicate
occurrence. Unchanged blocks survive unrelated paragraph insertion. Content edits,
renamed headings, and identical duplicate blocks can invalidate block identities;
text quote/context recovery provides a second resolution path. Authored durable
block IDs would make frequent content revisions more predictable.

Freehand points retain their authored offsets in storage. Their origin follows
the block; rendering uniformly scales strokes wider than the reading column and
clamps them horizontally. Wider layouts restore the original size. Sketches
spanning multiple blocks do not track each word. Convert a recognized underline
or explicitly select text when semantic tracking is needed.

## State, sharing, and lifecycle

The functional core lives in `docs/lib/annotations/`: data types, document
validation/serialization, sharing codecs, and geometry.
The stateful annotation component lives in `docs/components/annotations/`: DOM
rendering, text ranges, gesture attachment, events, browser persistence, URL synchronization, and
mounting. `annotation-layer.astro` mounts that component. CSS stays in
`docs/styles/`.

Tests mirror those responsibilities in `docs/test/lib/annotations/` and
`docs/test/components/annotations/`, with shared fixtures in `docs/test/helpers/`.
Each group keeps its own specialized helpers in a nested `helpers/` folder.

`model.ts` defines the serializable document. `codec.ts` validates and serializes
it; `share.ts` encodes and decodes the same data for URLs. The component's
`storage.ts` owns browser persistence. The editor receives state and callbacks
and does not access storage or the URL. `mount.ts` owns Astro lifecycle, URL
precedence, clipboard sharing, and `url-state.ts` synchronization.

Local storage is per origin and normalized pathname, ignoring query/fragment.
Edits save locally and update the URL after a short debounce. Each `notes`
payload written for a locally saved document is recorded, as a short hash, for
that page (the most recent 200). A valid `notes` URL is then one of two things:

- This browser's own history: Back/Forward, a heading or outline entry, a
  reload, or a remount before the debounce finished. Local notes are at least as
  new, so they are shown and the entry's address is updated to match. Navigation
  does not roll notes back.
- A shared snapshot from elsewhere. It is shown without changing local notes.
  The first edit keeps the earlier local notes as one previous copy and then
  saves the snapshot locally. The annotation menu offers Restore previous notes,
  which swaps the two copies, so neither is lost. If the previous copy cannot be
  written, local notes are left unchanged and the edit stays in the address only.

Opening a link this browser created shows its current notes, not that older
snapshot. Only one previous copy is kept: editing a second shared link replaces
it. Without browser storage, the URL remains the only copy and wins on every
visit. Absent URL state uses local notes; invalid URL state reports an error and
preserves the saved copy. Clipboard sharing copies the complete current link. If
the notes change while a link is being created, nothing is copied and Share asks
to be chosen again. If clipboard access fails, the link remains in the browser
address for manual copying.

URL updates preserve unrelated parameters, heading fragments, and Astro history
state. Revision and disposal guards prevent stale compression results from
replacing newer edits or updating a different page. Page swaps dispose listeners,
observers, drafts, and pending URL work. Popstate and Astro page-load restore the
current page's state with one editor host.

Links use compact tuples, optional native gzip, and URL-safe base64. The complete
URL has a 2,000-byte practical QR target and an 8,000-byte hard link cap. The target
is a product budget, not a universal QR scanner guarantee. Over-limit documents
remain local without truncation; a stale annotation parameter is removed rather
than leaving a link to an older state. Hiding the layer leaves an existing link
unchanged. There is no server-backed short-link service or QR generator yet.

See [annotation-sharing.md](annotation-sharing.md) for format details, bounds, and executable
size fixtures. Mark limits are 300 marks, 2,000 points per stroke, and 2,000 text
characters per note. Text targets allow up to 32 segments and 8,000 quoted
characters. The decoder rejects invalid values, unsupported payloads, repeated
parameters, malformed compression, and oversized expansion.

## Verification

Focused Vitest coverage includes legacy/new storage, malformed and oversized
links, compression bounds, URL races, inline/cross-paragraph selections, Unicode,
quote recovery/ambiguity, context-free relocation, reflow rectangles, gestures,
editor lifecycle, visibility, comment editing, and capacity draft retention. The
mount lifecycle suite drives `mount.ts` through same-page fragment Back/Forward,
an edit immediately before heading navigation, reloads, page swaps, shared-link
import with previous-copy restore, a failed backup write, and Share during an
edit or navigation.

T3 browser validation on 2026-11-05 exercised:

- Native freehand dragging and native text selection across paragraphs.
- Explicit highlights/underlines, code selections, Unicode comments and editing.
- Arrow attachment and confirmed freehand-to-underline conversion.
- Content-change orphan handling and reattachment.
- URL-only restoration with local storage removed, malformed links preserving
  local data, and eye toggling with exact URL/data equality.
- Clipboard sharing, native page navigation/back, and reading-mode reflow.
- 320px/390px phones, 844x390 landscape, and 1440px desktop; light/dark themes.
- An actual seven-mark document at 1,214 URL bytes. A dense-stroke example would
  produce a 49,874-byte link; sharing was refused with all eight local marks intact.
- A follow-up pass on 2026-11-05 used real Astro heading links: edit, heading,
  edit, Back, edit, and Forward kept every note and re-synced each entry's
  address. An edit made just before a heading click survived. A URL-only
  reload with different local notes opened the snapshot and left local notes
  intact; the first edit kept them as the previous copy, and Restore swapped
  the two. Share during an edit copied nothing and asked to share again.

This is desktop browser automation with resized CSS viewports, not physical-device
or mobile-touch acceptance. Content editing, multi-user collaboration, server
persistence, and arbitrary-size short links remain outside this implementation.
