# Design

The design system record for the typography studio. The code is in `src/ui`,
the shell in `src/app`, and every part is shown in every state at `#/system`.

The brief: a garment care label. Symbols carry meaning. The interface is drawn
in one-pixel line, like a wireframe for a newspaper, in very light type. Only
letterforms, meaning the user's own fonts, carry mass.

## Tokens

Defined in `src/ui/tokens.css` as custom properties. Use them; do not write
colour or font values in a screen.

| Token | White tape | Black tape | Used for |
| --- | --- | --- | --- |
| `--tape` | `#f7f8f7` | `#0b0c0d` | The ground. |
| `--ink` | `#0b0c0d` | `#f7f8f7` | Source glyphs, rules, type, controls. |
| `--rule` | ink at 26% | ink at 30% | Hairlines between things of one kind. Never text. |
| `--carbon` | `#1f3bd0` | `#9db0ff` | Anything made after the source font. |

White tape is the default. Black tape is its inverse. A theme only swaps these
four values, so `data-theme="black"` works on the root (the theme toggle sets
it there) and on any element (`Tape` does that). The choice is kept in
`localStorage` under `typography.theme`.

Space: `--space-1` to `--space-6` are 4, 8, 12, 16, 24 and 30 pixels. Controls
are `--control-height` (32 pixels) tall. Running text is at most `--measure`
(62 characters) wide.

## Type

Type gets lighter as it gets larger, so its strokes stay near one pixel.

| Token | Class | Rule | Face |
| --- | --- | --- | --- |
| `--type-display` | `ty-display` | 100 at 44 px and up, capitals | Sofia Sans Extra Condensed |
| `--type-heading` | `ty-heading` | 200 at 24 px | Sofia Sans |
| `--type-body` | (the default) | 300 at 13 px | Sofia Sans |
| `--type-label` | `ty-label` | 400 at 11 px, capitals, 0.08em tracking | Sofia Sans Condensed |
| `--type-code` | `ty-code` | 400 at 10.5 px, 0.04em tracking | Sofia Sans Condensed |

Thin type is always full ink, never thin and grey. Nothing is set below
10.5 px. Numerals are tabular. The fonts are bundled from `@fontsource-variable`
by `src/ui/styles.ts`; nothing is fetched from another host.

## Symbols

Authored SVG in `src/ui/symbols/drawings.tsx`, drawn by `LineSymbol`.

- One stroke, one pixel wide, in `currentColor`, with
  `vector-effect: non-scaling-stroke`. No fills.
- Places are drawn on a 40 unit grid; marks and control symbols on 22.
- Straight strokes sit on half-pixel coordinates so they land on whole pixels.
  Keep a symbol at its drawn size and on a whole-pixel position.
- A symbol always keeps its name beside or below it, so it is hidden from
  assistive technology and never stands alone. There are no icon-only buttons.
- Never use a Unicode glyph or an emoji as a symbol.

Places: Import, Library, Coverage, Studio, Generate, Reconstruct, Proof,
Export. Controls: add, remove, check, close, search, download, undo, redo,
compare, pin, and four chevrons.

## Marks

`Mark` prints one of six marks with its name. Marks come from provenance and
coverage in the domain, never from an ad hoc flag.

| Kind | Drawing | Meaning |
| --- | --- | --- |
| `source` | Ink box | In the source font. |
| `edited` | Solid carbon box | Edited by hand. |
| `unconfirmed` | Dotted carbon box | Generated or inferred, not yet accepted. |
| `missing` | Crossed ink box | The character is missing. |
| `level` | Three dots, some filled | Coverage level, 0 to 3. |
| `revisions` | Box over a line | Has revisions. |

The same language runs through `GlyphCell` (solid carbon frame for an edit,
dotted for a candidate), `Tofu` (the crossed box at any size) and
`CompositionList`. A missing character always gets the app's crossed box,
never a system fallback font.

## States

States are printed marks. Colour does not change to show a state.

| State | Mark |
| --- | --- |
| Hover | A bar underneath. Free-standing controls get a second rule 4 px below; cells in a ruled strip underline their name. |
| Focus | A one-pixel ink outline, 3 px away. Inside a filled cell it is drawn in tape, inset. |
| On | A filled box: ink, with tape type. A selected glyph cell fills with the colour of its layer. |
| Unavailable | A line through. The control keeps full ink. |

A problem is "on", so its tag is a filled box; a note's tag is an outline.

The specimen shows hover, focus and drag-over without a pointer by wrapping a
sample in `data-force="hover"`, `"focus"` or `"over"`. Every stylesheet lists
the forced selector together with the real pseudo-class, so add both when you
add a state.

## Components

Import each from its own file; there are no barrel files.

- `src/ui/controls`: `Button`, `ButtonLink`, `ToggleButton`, `Segmented`,
  `Slider`, `TextField`, `SearchField`, `Select`, `Checkbox`, `Tabs`,
  `FileDrop`, `Notice`, `ProgressLine`.
- `src/ui/content`: `SectionHead`, `TitleBlock` and `TitleBlockItem`,
  `DataTable`, `GlyphCell`, `GlyphGrid`, `Tofu`, `CompositionList`,
  `EmptyState`.
- `src/ui/symbols`: `LineSymbol`, `Mark`.
- `src/ui/layout`: `RuledSection`, `Columns`, `SplitView`, `ScrollRegion`,
  `Tape`.

Every control is a native element underneath (button, radio, checkbox,
select, range, file input), so it has a name, takes focus and works from the
keyboard. `src/ui` imports nothing from the domain: components take plain
strings and numbers, and the screen maps provenance and coverage onto them.

## Layout

- A screen is a stack of `RuledSection`s. Each opens with an ink rule and a
  `SectionHead`: a light heading and a one-sentence lede. The first passes
  `first` and carries no rule.
- Ink rules separate things of different kinds; `--rule` hairlines separate
  things of one kind: rows, cells, columns.
- `Columns` puts hairlines between columns and none outside. It stacks below
  560 px.
- `SplitView` puts an inspector column beside the work, fixed or resizable.
  Below 720 px the inspector moves underneath.
- `ScrollRegion` scrolls inside a frame its parent sizes. The shell's screen
  area already scrolls; only fixed-height panes need one.
- Widths respond to the container, not the viewport, so a component behaves
  the same in a narrow inspector as on a phone. The app works from 360 px.

## Shell

`src/app/places.tsx` is the registry of the eight places and the one spot
where a screen is plugged in: add `screen: lazy(() => import("~/library/library-screen"))`
to its line. A screen is a default export taking `{ path }`, the segments
below its place. Until a place has a screen the shell says so.

Location is the URL hash: `#/studio/<face>/<glyph>`. Link with a plain
`<a href="#/studio/...">` or `ButtonLink`. `#/system` is the specimen and is
not in the strip. The masthead has a slot for project status: `<App status>`.

## Copy

Plain sentence case. No em dashes and no exclamation marks. A control names
its action. An error names the problem and the way out.

## Do

- Draw every interface stroke one pixel wide.
- Let the user's letterforms be the only heavy thing on screen.
- Use ink for the source font and carbon for anything made after it.
- Print the name beside every symbol and mark.
- Say honestly when something is absent, a stand-in, or not built.

## Do not

- No corner radius, shadows, gradients, stacked cards or glass.
- No grey text, and no colour other than the four tokens.
- No dotted carbon frame on anything but unaccepted generated or inferred work.
- No crossed box for anything but a missing character.
- No Tailwind, CSS-in-JS or component library. Plain CSS with a `ty-` prefix.

## Names that differ from the brief

The lint rules decide two names. The symbol component is `LineSymbol`,
because a component called `Symbol` would shadow the JavaScript global. The
shell file is `src/app/app.tsx`, because file names are kebab-case.
