# URL state, pointers, and marks: contracts (proposal)

Supporting artifact for [plan.md](plan.md), Phase B. Everything here is a
recommendation. The shapes below are TypeScript sketches, not code to
implement yet.

The query keys, history strategy, sharing policy and URL-size budget are
provisional design choices. Source inspection has not established actual
browser navigation behavior; verify that interaction before adopting the
router-specific rules below as implementation constraints.

## User-facing behavior and proposed engineering criteria

- Shareable URL state that can affect layout.
- Scribbles or drawn annotations.
- Ways to point to parts of pages.
- Layout state kept separate from mark strokes.
- Stable page and section anchors, coordinates that survive viewport and layout
  changes, versioned encoding, size limits, reset and back/forward behavior,
  share and read flows.

## Constraint found in the router

Blume runs Astro's `ClientRouter` on every page. In Astro 7.3.2
(`dist/transitions/router.js`):

- `samePage(a, b)` is `pathname` equal and `search` equal (line 7).
- A navigation on the same page that only changes the hash scrolls in place.
- A navigation, including back/forward through `popstate`, between two entries
  with the same path and a different `search` fetches the page and swaps the
  DOM.
- `onPopState` (line 384) ignores entries with `state === null` and reads
  `state.index` from the others to compute direction.

Two rules follow:

1. **Never `pushState` from our code.** The router's history index is private.
   An entry we push either lacks `index` (wrong direction on traverse) or has
   `state === null` (the router ignores it, then mis-handles the next
   traverse). Live edits call `history.replaceState(history.state, "", url)`,
   passing the router's state object unchanged so its `index` and scroll
   fields survive. A spread (`{ ...history.state }`) would turn a `null` state
   into `{}`, which the router then reads as an entry without an index. If
   `history.state?.index` is undefined, the router has not initialized this
   entry, and the write waits until `astro:page-load`.
2. **Keep the hash for anchors.** Blume's heading links, `:target`, the TOC,
   and browser fragment scroll all assume `#<id>`. A hash like
   `#durability~v1...` matches no element, so the browser does not scroll and
   `:target` never matches. Browser text fragments (`#:~:text=`) also live in
   the hash, and pages cannot read them back.

So state goes in the query string and the hash stays a plain anchor. The cost
is bounded: back/forward between two entries of the same page whose queries
differ causes one same-page fetch and swap. That happens only after a reader
edits state and then follows an in-page link. Islands re-read the URL after
the swap, so the restored entry shows its own state. This needs a browser
check before it is relied on.

Alternative, rejected for now: state in the hash after a separator, with our
own scroll handling. It avoids the swap but breaks native fragment behavior on
every page that has state.

## Parameters

| Param | Holds | Written when | Example |
| --- | --- | --- | --- |
| `p` | A pointer: one section or block to bring into view and outline | On load from a shared link; "Copy link to this paragraph" builds it | `?p=1.replay-is-different-from-retry.2.k3f9` |
| `l` | Layout state | Live, on every layout change (replaceState) | `?l=1.f.e~retry-options` |
| `m` | Marks (ink and highlights) | Only when the reader chooses Share (recommendation) | `?m=1.<deflate-raw base64url>` |

Each value starts with its own schema version and a dot. Each is decoded
alone, so a bad `m` never discards a good `l`. The hash is untouched.

Unknown params are left in place. Other params on the URL (analytics,
search) are preserved.

## Anchors

A target is resolved in order, stopping at the first that works:

1. `section`: the heading id. Pages expected to be pointed at get pinned
   anchors (`## Replay is different from retry [#replay-vs-retry]`) so a
   reworded heading does not break links. Recommendation: pin anchors on the
   three illustration pages first, then on Reference pages.
2. `block`: the zero-based ordinal of the block (paragraph, list item, code
   block, table, figure) within the section.
3. `hash`: a short hash of the block's normalized text (lowercase, whitespace
   collapsed, first 200 characters). It confirms the block is the same one.
   On mismatch, search the section for a block with that hash. If none
   matches, the target is an orphan.

```ts
// Sketch
interface BlockAnchor {
  section: string;   // heading id; "" for the text before the first heading
  block: number;     // ordinal within the section
  hash: string;      // 4 base36 chars of a 32-bit FNV-1a over normalized text
}

interface TextQuote {   // for highlights, after W3C TextQuoteSelector
  anchor: BlockAnchor;
  exact: string;        // selected text, capped at 300 chars
  prefix: string;       // up to 32 chars before
  suffix: string;       // up to 32 chars after
}
```

Pointer encoding: `1.<section>.<block>.<hash>`. Omitting `block` and `hash`
points at the whole section.

## Coordinates for ink

Ink must not be stored in viewport or page pixels. Text reflows when the
window width, font loading, sidebar visibility, or `l` layout changes.

- A stroke belongs to the block under its first point.
- Points are stored relative to that block's border box: `x` as a fraction of
  the block's width, `y` as a fraction of the block's height. Both are
  quantized to 1/1024 (10 bits).
- On reflow, the overlay recomputes each block's box (one `ResizeObserver` on
  the article) and redraws.
- Known limit: when a paragraph rewraps, a stroke that underlined line 2 may
  land between lines. Exact text marking is what highlights are for; ink is
  approximate by design. The UI should say so in its help text.
- Strokes that cross several blocks stay attached to the first block. They
  are not split.

Highlights use `TextQuote` and render through the CSS Custom Highlight API
where available, falling back to wrapping `<mark>` elements. They reflow with
the text.

## Mark schema

```ts
// Sketch, version 1
type Mark =
  | { kind: "ink"; anchor: BlockAnchor; tool: "pen" | "marker";
      color: 0 | 1 | 2 | 3;          // palette index, theme-aware
      points: readonly number[] }     // [x0, y0, dx1, dy1, ...] quantized, delta-encoded
  | { kind: "highlight"; quote: TextQuote; color: 0 | 1 | 2 | 3 }
  | { kind: "note"; anchor: BlockAnchor; text: string };  // capped at 280 chars

interface MarksV1 {
  v: 1;
  route: string;      // the page the marks belong to, checked on decode
  marks: readonly Mark[];
}
```

Colors are palette indexes, not CSS values, so marks read correctly in light
and dark themes.

## Layout schema

Layout state changes how the page is laid out. It never contains marks.

```ts
// Sketch, version 1
interface LayoutV1 {
  v: 1;
  focus?: boolean;                 // hide sidebar and TOC
  expanded?: readonly string[];    // ids of <Expandable>/<Accordion> items to open
  tabs?: Readonly<Record<string, string>>;  // Tabs group id → selected tab
  marks?: "show" | "hide";         // whether shared marks are drawn
}
```

Compact text form, to keep it readable in the address bar:
`1.f.e~retry-options~package-instances.t~install:bun`. Flags are single
letters; lists are `~`-separated; ids are already URL-safe slugs.

Whether Blume's `Tabs` and `Accordion` expose stable ids that a script can
drive is not verified. `componentSlug` (`blume/src/components/slug.ts`) slugs
component titles the same way as headings, which suggests yes.

Applying layout before first paint needs an early script (Blume has
`components/layout/head-scripts.ts`; whether a project can add to it is not
verified). Without it, a focus-mode link shows the sidebar for one frame.

## Encoding

1. Build the versioned object.
2. Marks only: simplify each stroke (Ramer–Douglas–Peucker, tolerance
   2/1024), quantize, delta-encode.
3. Serialize to a compact array form (positional fields, no key names).
4. `CompressionStream("deflate-raw")`, then base64url without padding.
5. Prefix `1.`.

Decoding reverses this inside `try`. Any failure leaves the page usable and
shows a short notice ("This link's marks could not be read"). A newer
version than the reader understands shows "This link was made with a newer
version of the docs" and ignores only that param.

The editor prototype's `parseDocument` (`apps/editor/src/documents/document.ts`)
is the model: accept every known version, upgrade old ones, and name the
version it cannot read.

## Size limits

| Limit | Value | Reason |
| --- | --- | --- |
| Soft cap for `m` | 2,000 characters | Survives chat apps, issue trackers, and email clients that truncate or wrap long links. |
| Hard cap for the whole URL | 8,000 characters | Common request-line limit on CDNs and static hosts. GitHub Pages' exact limit is not verified. |
| Over the soft cap | Share offers "Download marks (.json)" instead of a link; import reads it back | No silent truncation. |

Rough budget, not measured: a simplified stroke of about 12 points is around
30 bytes before compression, so the soft cap fits a few dozen strokes plus
highlights. A real measurement belongs in the marks slice.

## Behavior

| Situation | Behavior |
| --- | --- |
| Reader opens a link with `p` | Scroll to the target and outline it, then remove `p` with `replaceState` so a reload does not jump again. The heading hash, if any, stays. |
| Reader edits layout | `replaceState` with new `l`, debounced 250 ms. No new history entry. |
| Reader draws | Marks go to a local draft (`localStorage`, key per route and schema version). URL unchanged. |
| Reader presses Share | Encode marks into `m`, `replaceState`, copy the full URL. |
| Reader opens a link with `m` | Read-only "Viewing shared marks" bar with "Keep a copy" (copies into the local draft) and "Dismiss" (removes `m` with `replaceState`). Shared marks are never merged into the reader's own draft without asking. |
| Reset layout | Remove `l`. |
| Clear marks | Remove `m` and clear the draft, with undo. |
| Back/forward to another page | Router behavior unchanged. The returning entry carries whatever `l`/`m` was replaced into it, and islands re-read it on `astro:page-load`. |
| Navigate to another page via a link | Query is dropped by the link's own href. Layout state does not follow the reader across pages. A site-wide preference (for example, always focus mode) would be `localStorage`, not URL. |
| Orphaned marks after the page changed | Not drawn in a wrong place. Listed in the marks panel as "Could not place", with the stored text excerpt. |
| Undo/redo | In-memory snapshots of the mark array, coalescing edits within 600 ms, at most 100 steps (same numbers as `apps/editor/src/editor/history.ts`). |

## Collections (pointing across pages)

A write-up collection spans pages, so it does not live in a page's URL.
It is a list of pointers kept in `localStorage`:

```ts
// Sketch
interface CollectionV1 {
  v: 1;
  items: readonly { route: string; anchor: BlockAnchor | { section: string };
                    addedAt: number }[];
}
```

If collections need to be shared by link later, a `/collect?c=1.<encoded
pointers>` page could render them. Pointers are small (route plus anchor), so
a dozen fit well under the soft cap. Not proposed for the first slices.
