---
name: Foundry website foundation
description: Provisional visual reference extracted from the static Astro implementation.
colors:
  paper: "#f8f9fc"
  ink: "#151b2b"
  muted: "#535d72"
  accent: "#254cdc"
  line: "#d5dae5"
  wash: "#edf0f8"
  inverse: "white"
  accent-hover: "#1939b0"
  closing-muted: "#c4ccdf"
  inverse-hover: "#dfe5ff"
  inverse-focus: "#b7c5ff"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "clamp(3.2rem, 7.2vw, 6rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "clamp(2rem, 3.3vw, 2.8rem)"
    fontWeight: 600
    lineHeight: 1.18
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 600
rounded:
  button: "4px"
spacing:
  link-gap: "12px"
  content-gap: "40px"
  section-gap: "70px"
  section-block: "100px"
  section-block-mobile: "60px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.inverse}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "15px 22px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.inverse}"
  button-inverse:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "15px 22px"
  button-inverse-hover:
    backgroundColor: "{colors.inverse-hover}"
  text-link:
    typography: "{typography.label}"
  navigation:
    textColor: "{colors.ink}"
  tool-row:
    padding: "44px 0"
---

# Design System: Foundry website foundation

## Overview

This records the current static Astro foundation. Its colors and type are provisional implementation choices informed by the live foundry.sh reference. Brand direction and the manifesto remain deferred; no creative metaphor or permanent identity is approved here.

The implemented page uses large headings, open spacing, ruled tool listings, and a single blue accent. It introduces creation tooling broadly before presenting today's developer tools as evidence. Product scope and open decisions belong in PRODUCT.md.

**Key Characteristics:**

- Light backgrounds with dark text and blue emphasis.
- Flat sections, thin dividers, and text-led tool listings.
- Self-hosted Inter with regular and semibold weights.

## Colors

The accent marks selected headline words, the wordmark suffix, primary links, and the geometric illustration. Paper is the page background; wash separates the vision section. Ink supplies headings and the dark closing section. Muted supports body copy, and line defines dividers. The closing section uses its own lighter text, hover, and focus treatments.

## Typography

Inter is self-hosted in weights 400 and 600 with a sans-serif fallback and font synthesis disabled. Display, headline, title, body, and label values above describe the desktop implementation. Headings use balanced wrapping.

At 600px and below, display type changes to `clamp(2.7rem, 9.3vw, 3.5rem)`, tool titles to 29px, and prose to 16px. Hero copy is 21px with 1.65 line height, falling to 18px on mobile. Lead prose is 25px with 1.5 line height, falling to 22px. Prose is capped at 65ch.

## Layout

The shared container is at most 1200px wide with 48px side gutters. Gutters become 32px at 900px and 20px at 600px. Main sections use the section spacing tokens; closing and footer sections are shorter.

The vision uses two equal columns. Tool rows use `1fr 1.4fr 0.7fr`, reduce to two columns at 900px, and stack at 600px. The supplementary tool detail disappears at 900px. Hero actions and closing content stack at 900px; the header wraps and the footer stacks at 600px. Navigation remains visible without a menu control.

## Elevation & Depth

There are no shadows. Background changes and thin borders separate sections. The dark closing section provides the strongest tonal change.

## Shapes

Buttons have the small corner radius recorded above. Sections and tool rows have straight edges. A decorative outline square, circle, and triangle overlap in the creation strip; this is an implementation illustration, not an approved identity asset.

## Components

- Primary and inverse action links use inline arrows, a 52px minimum height, and a 160ms background transition. The inverse variant appears in the dark closing section.
- Text links remain underlined and have a 44px minimum height. Navigation links use the same minimum height without underlines.
- All links have visible keyboard focus, with a 2px outline offset by 6px. Closing links use the lighter focus color.
- Tool listings are semantic articles separated by top borders. They have no card background or shadow.
- The skip link becomes visible on focus. The decorative mark reveals over 900ms; reduced-motion preferences disable that animation, button transitions, and smooth scrolling.

## Do's and Don'ts

- Do preserve visible keyboard focus and reduced-motion support.
- Do use the extracted tokens for consistency while this foundation is in place.
- Don't treat these provisional colors, typography, or illustration as approved permanent branding.
- Don't infer form, card, or application interaction patterns from this static website.
