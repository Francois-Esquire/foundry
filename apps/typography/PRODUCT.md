# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, Vite and TypeScript in the browser, chosen by the user. Bun and Turborepo
from the monorepo. Everything stays in memory in the first prototype: no accounts,
no database, no persistent storage. Later runtimes (desktop, remote services,
persistent projects) are possible but not committed.

## Users

Assumed, not confirmed by the user: type designers, brand and graphic designers,
and creative technologists who want to explore, edit and extend typefaces without
a dedicated font-engineering toolchain. They work at a desk, in long sessions,
comparing letterforms closely.

## Product Purpose

A creative typography studio for exploring, editing, generating, reconstructing
and extending typefaces across the world's writing systems. It should feel like a
creative instrument, not a font utility.

There are two entry points, and both end in the same Font Studio:

- Typeface extension. Start from an existing font and extend it into new
  characters, writing systems, weights or variants. Example: import Roboto and
  generate a coherent Devanagari extension.
- Typeface reconstruction. Start from visual evidence such as a photograph of
  lettering and reconstruct an editable typeface. Example: photograph a vintage
  storefront and rebuild a Latin alphabet from what is visible.

## Positioning

Import, edit, generate, reconstruct, validate and export all operate on one shared
Typeface Project. A glyph that came from a font file, a manual edit, a generation
model or a photograph enters the same editor and the same export.

## Operating Context

- A Typeface Project holds source fonts, families, faces, Unicode mappings, glyphs,
  geometry, metrics, contextual rules, generated candidates, reconstructed
  lettering, design variations, revisions and export configurations.
- A Unicode character is not a glyph. Several glyphs can represent one character
  and one glyph can represent several characters.
- First writing systems to explore: Latin, Greek, Cyrillic, Arabic, Hebrew and
  Devanagari. Other scripts must fit without a custom implementation each.
- Shaping uses established engines. The product does not invent a replacement.

## Capabilities and Constraints

Five workstreams, built in this order of dependency:

- Typeface Foundation: import, inspection, families and faces, character-to-glyph
  mappings, outlines, metrics, variable axes, layout features, revisions.
- Library and Font Studio: library, specimens, Unicode coverage explorer, search,
  glyph editing, spacing and kerning, composition, revision comparison, candidate
  inspection.
- Generative Typography: style analysis, glyph generation, script extension,
  coordinated weights, with interchangeable generation strategies.
- Packaging and Validation: compilation, selective export, subsets, static and
  variable output, independent validation, shaping tests, visual regression.
- Typeface Reconstruction: image import, character detection, font matching,
  vector recovery, inference of missing characters, evidence and provenance.

Constraints the user set:

- Source fonts and source images stay intact. Edits and generated designs are
  nondestructive and reversible.
- No provider lock-in. A generation provider can be replaced without changes
  across the app.
- Observed lettering and inferred designs are always distinguishable.
- Mock or fixture output is never presented as real model output.
- A script is not called supported because its basic characters exist.
- Source-font licences are checked before modified derivatives are exported.

Undecided: which generation providers ship in the app, and the spending limit for
generation experiments.

## Brand Commitments

- Working name: typography.
- Visual constraint set by the user: the feel of a garment care label. Symbols and
  pictograms carry meaning. Interface lines are very thin and structural, like a
  wireframe for a newspaper, with very light type weights for the interface.
  Content, meaning the letterforms and specimens, is rich.

## Evidence on Hand

No fonts, images or generated artifacts exist yet. Test assets will be collected
under suitable licences during the build. Nothing here may be presented as a real
customer, benchmark or model result until it exists.

## Product Principles

- Automation by default, creative control when wanted.
- One coherent product. No disconnected demonstrations.
- Nondestructive operation. Originals and evidence stay available.
- Script-aware design. Latin assumptions are not forced onto other scripts.
- Honest reporting of what works, what is experimental and what is unavailable.
