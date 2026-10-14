---
name: Foundry
description: An exploded-assembly drawing system on warm paper, with expressive headings, real code, and plain part lists.
colors:
  workbench: "#f4f1ea"
  paper: "#fbf9f4"
  ink: "#1c1a17"
  muted: "#6b665d"
  line: "#d6d0c4"
  sage: "#e9e4d8"
  accent: "#3a3631"
  plate-left: "#e2ddd1"
  plate-right: "#cbc4b4"
  code-surface: "#1c1a17"
  code-raised: "#2a2722"
  code-text: "#d9d3c5"
  code-muted: "#8d867a"
typography:
  display:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(2.5rem, 4.2vw, 3.875rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  headline:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(2rem, 3.4vw, 3rem)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.08em"
    textTransform: uppercase
  code:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'
    fontSize: "13px"
    lineHeight: 1.7
  wordmark:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "24px"
    fontWeight: 700
    letterSpacing: "-0.04em"
rounded:
  illustration: "3px"
  code: "4px"
  button: "5px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
    padding: "14px 23px"
  button-inverse:
    backgroundColor: "{colors.workbench}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "14px 23px"
  code-panel:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.code-text}"
    rounded: "{rounded.code}"
---

# Design System: Foundry

## Overview

The page is drawn like an exploded assembly diagram. "Tools that come apart" is shown, not only said: the hero draws Marbles pulled apart into six of the libraries it imports, the Marbles section annotates a real workflow file, and a parts list closes the tools section. Everything sits on one warm paper tone with a single dark ink.

**Key characteristics:**

- Thin ink line drawings with leader lines and monospace part labels.
- One paper tone for the whole page. Gray or dark surfaces appear only where they mean something: the code panel and the closing field.
- Monospace uppercase labels for sections and product names. Bricolage carries the headlines; Inter carries the prose.

## Colors

- **Workbench:** The page background, a warm off-white.
- **Paper:** The lighter face of drawn plates, text on dark fills, and the inverse button.
- **Ink:** Text, line work, filled actions, the code panel, and the closing field.
- **Muted:** Secondary prose, labels, line numbers, and the drawing's axis.
- **Line:** Rules between sections and table rows.
- **Plate left / plate right:** The two shaded side faces of drawn plates.
- **Sage:** The Spyglass illustration field.
- **Code tokens:** Keywords are bold white, strings a warm gray, comments italic and dim. Marked lines sit on the raised code color.

## Typography

Only the hero headline uses the display scale. Product headlines, the parts heading, and the closing heading use the headline scale; the About heading is slightly smaller. Section labels and product names are monospace uppercase at 12px with wide tracking. Package names in the drawing and the parts list are monospace. The Works joke is a 22px Bricolage line, kept below the headline scale so it doesn't compete.

## Layout

The container is capped at 1280px with 56px gutters, reducing to 32px at 1000px and 20px at 700px.

- **Hero:** Copy and drawing in a 1.1 / 0.9 grid. At 1000px and below the drawing stacks under the copy.
- **Product heads:** Marbles and the parts list use a two-column head: label and headline on the left, description and link on the right, aligned to the bottom.
- **Marbles walkthrough:** The code panel and the notes split 8 / 4. Notes stack under the code at 1000px and below.
- **Spyglass and Works:** Copy and illustration in two equal columns, stacking at 700px.
- **Parts list:** A full-width table with package, description, and users. Below 700px each row becomes a stacked block and the header row hides.

## Components

- **Exploded stack:** An isometric SVG built in `src/components/exploded-stack.astro` from the list of libraries. The tool plate is larger and carries three marbles. Library plates are smaller, evenly spaced along a dashed center axis, and have a dashed inset. Every plate has a leader line to a label in one aligned column. Parts are not numbered and the drawing has no figure caption.
- **Code panel:** File path header, line numbers, and numbered marks in the gutter on the lines the notes explain. Line numbers and marks are hidden from assistive technology and from selection. Long lines scroll horizontally.
- **Code notes:** An ordered list with ink-filled number marks that match the gutter marks.
- **Parts list:** A table whose package names link to the source.
- **Actions:** The primary action is an ink button; the closing field uses the inverse button. Text links are underlined with an arrow.

## Do's and Don'ts

- Do keep the drawing true to the real package graph.
- Do pin explanations to real code instead of drawing diagrams of it.
- Do use one paper tone; give a surface its own color only when it marks something.
- Don't number parts or add figure captions to the drawing.
- Don't invent illustrations of product behavior. The Spyglass graph is a placeholder until a real render replaces it.
- Don't add shadows or floating cards.
