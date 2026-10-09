---
name: Foundry
description: A monochrome visual system with expressive headings and plain, readable tool descriptions.
colors:
  workbench: "#fafafa"
  paper: "#ffffff"
  ink: "#202020"
  muted: "#626262"
  line: "#dedede"
  clay: "#eeeeee"
  sage: "#e5e5e5"
  accent: "#404040"
typography:
  display:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(2.5rem, 5.1vw, 4.25rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  headline:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(2rem, 3.4vw, 3rem)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "22px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  product-name:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  wordmark:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "24px"
    fontWeight: 700
    letterSpacing: "-0.04em"
rounded:
  illustration: "3px"
  button: "5px"
spacing:
  text-link-gap: "22px"
  action-gap: "30px"
  navigation-gap: "32px"
  shelf-gap: "42px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "14px 23px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
  button-inverse:
    backgroundColor: "{colors.workbench}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "14px 23px"
  button-inverse-hover:
    backgroundColor: "{colors.paper}"
  text-link:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  tool-art-clay:
    backgroundColor: "{colors.clay}"
    rounded: "{rounded.illustration}"
  tool-art-sage:
    backgroundColor: "{colors.sage}"
    rounded: "{rounded.illustration}"
---


# Design System: Foundry

## Overview

Foundry currently uses a monochrome palette, Bricolage Grotesque headings, Inter body text, and a compact text wordmark. Plain space and flat surfaces keep the tools and their descriptions easy to scan. Color direction remains open; the neutral palette is the current implementation, not a new permanent brand identity.

A monospaced code block (the Marbles authoring example) and the existing Atlas vector illustration appear below the first fold in neutral tones. The homepage surface contract owns the approved composition and copy. Sculpture source and styles remain in the repository for reference, but no sculpture or sculpture controls are mounted on the homepage.

**Key characteristics:**

- Expressive display lettering paired with restrained body text.
- Near-white surfaces, dark text, and subtle gray rules.
- Flat tool shelves, linked library rows, and small corner radii.

## Colors

The palette is entirely neutral. Existing CSS token names are retained to match the implementation; names such as workbench, clay, and sage no longer imply colored materials.

### Primary

- **Ink:** Primary text, filled actions, and the dark closing field.
- **Accent:** Hover text, focus outlines, and illustration details.

### Neutral

- **Workbench:** Near-white page background and inverse action fill.
- **Paper:** White tool-section background and text on dark actions.
- **Muted:** Secondary prose, small labels, and captions.
- **Line:** Light gray separators between linked library entries.
- **Clay / Sage:** Two gray illustration fields that distinguish the existing tool specimens.

## Typography

**Display font:** Bricolage Grotesque Variable, with sans-serif fallback.
**Body font:** Inter, with sans-serif fallback, locally served at regular and semibold weights.
**Illustration annotations:** Monospace for filenames, structured data, conditions, and existing map labels.

The frontmatter owns the default display, headline, title, body, label, and wordmark values. Only the hero headline uses the display scale. Product headlines, the closing heading, and the About heading use the headline scale (the About heading slightly smaller, `clamp(1.75rem, 2.6vw, 2.25rem)`). Product names and section headings ("Tools", "About Foundry") are Inter labels, not display type, so that one expressive level carries the page. Headings use balanced wrapping, except the primary headline, which uses pretty wrapping. The wordmark suffix is smaller (0.67em) and medium weight (500).

The hero description uses a larger body size (18px), relaxed line height (1.65), and muted text. At the mobile breakpoint it becomes 16px. Library titles are 19px, or 18px on mobile. The desktop wordmark is compact; mobile and footer wordmarks use 25px. The missing-page heading has its own larger scale (`clamp(3rem, 7vw, 6rem)`).

## Layout

The shared content container is capped at 1280px, with 56px side gutters. Gutters reduce to 32px at 1000px and 20px at 700px. The header is 88px tall. The current text-only hero has 88px top and 96px bottom padding, a headline measure of 920px, and a description measure of 620px. At 1600px and above, hero top padding becomes 65px; at 700px and below, padding becomes 52px above and 64px below.

Products occupy separate full-width sections with an 80px gap and thin dividing rules. Within each section, copy and an example form two columns separated by 64px; Marbles splits 5/7 so the code block gets the wider column. Below 700px the content stacks with a 32px gap; product separation becomes 52px. The Marbles example is a code block on a workbench-gray field with a file-path caption, muted comments, and no syntax coloring while the palette stays monochrome; long lines scroll horizontally. Works pairs its description with the word-processor joke and a module/artifact example. Illustration fields are 305px tall, 270px at the middle breakpoint, and 280px on mobile. The tool section uses 98px vertical padding and a 40px top margin; these become 60px and 20px on mobile.

Library links use three columns, two at 1000px, and one at 360px. The About area uses two columns (label and heading on the left, prose and link on the right) and 110px vertical padding, becoming one column with 64px padding on mobile. The closing area changes from a horizontal arrangement to stacked content on mobile.

## Elevation & Depth

The current system has no box shadows. Depth comes from neutral surface contrast, dark text, thin rules, and the existing character and vector illustrations. Actions use a brief background and text-color transition (160ms ease-out). Reduced-motion preferences disable transitions and smooth scrolling.

## Shapes

Action links have small rounded corners. Tool illustration fields and workflow annotations use the smaller illustration radius. Library entries use thin top rules rather than enclosing cards. There is no general card, form, or modal system to infer from these elements.

## Components

- **Primary action link:** Dark fill and light text, a thin matching border, semibold label, and inline arrow. It has a 54px minimum height and the padding defined in frontmatter. Hover changes the fill to accent.
- **Inverse action link:** The same geometry on the closing field, with workbench fill and ink text; hover changes the fill to paper. Its focus outline uses workbench for contrast.
- **Text destination link:** Underlined semibold text, a 44px minimum height, a 22px gap before the arrow, and accent text on hover.
- **Wordmark:** A compact Bricolage text link with a smaller `.sh` suffix. No adjacent logo mark is mounted.
- **Navigation:** Inline Marbles, Atlas, Docs, and GitHub links, with 44px minimum link height. Labels are 13px on desktop and 12px on mobile; gaps follow the navigation spacing token and reduce to 17px on mobile. The header GitHub link is hidden below 700px; footer destinations remain available. At 360px, link size becomes 11px and the gap 12px. There is no selected-route state on this page.
- **Keyboard focus:** Links use an accent outline (2px) offset by 5px. The closing area uses a contrasting workbench outline. The skip link appears on focus and targets the main content.
- **Tool shelves and library rows:** Semantic articles pair a small product-name label with a headline, description, example, and destination link. Works has a Coming soon label beside its name and no launch action. Library entries are flat linked text with separators.

The sidecar previews current link and navigation treatments. There are no live sculpture controls, ranges, or text-input patterns to document in this homepage system.

## Do's and Don'ts

- Do preserve the existing Bricolage and Inter pairing and compact wordmark.
- Do use the current neutral tokens consistently, including illustration details.
- Do retain visible keyboard focus and ordinary, clearly labeled destination links.
- Do keep the homepage composition and approved wording governed by its surface contract.
- Don't introduce a new color identity while that direction remains undecided.
- Don't add ambient shadows or turn flat tool shelves into floating cards.
- Don't treat inactive sculpture source as evidence of mounted homepage UI.
- Don't infer application forms, disabled states, or validation patterns from this website.
