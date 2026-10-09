---
name: Foundry workshop
description: A warm, tactile visual system for tools that people can make their own.
colors:
  workbench: "#eadb9b"
  paper: "#f6f3eb"
  ink: "#342d27"
  muted: "#665a46"
  line: "#c8bd9c"
  clay: "#ddbaaa"
  sage: "#d5dbc6"
  accent: "#65462f"
  control-hover: "#d9c985"
typography:
  display:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(4.5rem, 7.4vw, 6rem)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "clamp(2.7rem, 4vw, 3.7rem)"
    fontWeight: 600
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"Bricolage Grotesque Variable", sans-serif'
    fontSize: "36px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  control:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  control: "3px"
  button: "5px"
spacing:
  shape-gap: "4px"
  control-gap: "10px"
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
  shape-control:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  shape-control-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  shape-control-hover:
    backgroundColor: "{colors.control-hover}"
  motion-control:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  text-link:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  tool-art-clay:
    backgroundColor: "{colors.clay}"
    rounded: "{rounded.control}"
  tool-art-sage:
    backgroundColor: "{colors.sage}"
    rounded: "{rounded.control}"
---

# Design System: Foundry workshop

## Overview

**Creative North Star: "The warm, tactile workshop"**

Foundry is a warm, tactile workshop: sun-warmed yellow, brown-black ink, paper shelves, and small objects that invite handling. Expressive display lettering gives the work personality; plain body text makes the tools easy to understand.

Depth comes from material contrast and character-based forms. Controls feel practical and flat, with a quiet, deliberate motion vocabulary. The website is code-led: live ASCII geometry, authored character art, and inline vector drawings supply its imagery; no raster assets or approved image comp define this system.

**Key Characteristics:**

- Warm material colors with dark, readable text.
- Bricolage Grotesque headings paired with Inter prose.
- Open shelves, thin rules, compact corners, and hands-on ASCII forms.

## Colors

The palette feels like a sunlit workbench, paper stock, clay, and muted plant fibers. Frontmatter values are normative; the sidecar's generated tonal ramps are previews, not additional implementation tokens.

- **Primary:** Workbench supplies the warm page field. Brown accent emphasizes the final headline word, link hover, sculpture details, and focus.
- **Secondary:** Clay and sage distinguish the two tool specimens without changing the page's quiet material character.
- **Neutral:** Ink anchors text, selected controls, and the closing section. Paper supplies the tool shelf and inverse text. Muted carries supporting copy; line separates the workbench controls and caption. Control-hover provides the warm hover fill.

## Typography

Bricolage Grotesque Variable gives headings an irregular, crafted character. Inter supplies regular and semibold body text and controls. Both are served locally with sans-serif fallbacks; font synthesis is disabled. Monospace is reserved for character specimens and diagram labels.

The frontmatter records desktop roles. Hero supporting copy is larger (18px, line height 1.65); ordinary tool and vision prose uses the body role. Tool descriptions cap their measure at 52ch. Headings use balanced wrapping. Small captions and navigation use 11–13px text.

At the tablet breakpoint, display type becomes `clamp(3.8rem, 8vw, 5.5rem)`. On mobile it becomes `clamp(4.5rem, 14vw, 6rem)`; on the smallest breakpoint it becomes 3.8rem. Mobile headlines use `clamp(2.5rem, 8vw, 3.5rem)` and tool titles use 33px.

## Layout

The centered container caps at 1280px, with 56px desktop gutters. At 1000px and below gutters become 32px; at 700px and below they become 20px. The hero pairs copy and specimen in `0.95fr 1.05fr` columns. Tool shelves and the vision use two columns; library links use three, reducing to two on tablet.

At 700px, the hero, tool shelf, vision, and closing content stack. Main navigation remains visible, while its extra GitHub link hides; GitHub remains in the footer. At 360px, library links become one column and the header's geometric mark hides. At 1600px and above, the hero gains extra top space. These are content-driven breakpoints, not a generic application grid.

Section spacing is generous but varied: the tool shelf uses 98px block padding and the vision 110px; mobile uses 60px and 64px respectively. Specimen stages reserve their height before rendering, and controls wrap without squeezing labels.

## Elevation & Depth

There are no box shadows. Paper, workbench, clay, sage, and the dark closing field establish depth through contrast. Thin rules divide related content. ASCII shading and overlapping vector circles provide dimensional imagery while the surrounding interface stays flat.

## Shapes

Action links use the button radius; sculpture controls and tool artwork use the smaller control radius. Tool articles remain open on the paper shelf, without enclosing card borders. Thin straight dividers balance organic forms. The maker stamp is an outlined ellipse rotated slightly counterclockwise; it is decorative, not a control.

## Components

- **Action links:** Dark ink primary and warm inverse variants, with inline arrows, 54px minimum height, and a 160ms ease-out background/color transition. Hover changes the fill without moving the link. The inverse variant belongs on the dark closing field.
- **Text links and navigation:** Underlined text links and plain navigation each provide 44px minimum height. Hover uses accent ink. There is no separate active-route treatment on this single-page navigation.
- **Keyboard focus:** Links, buttons, and the range use a 2px accent outline with 5px offset. Closing links use a workbench outline. The skip link appears on focus and targets the main content.
- **Tool shelves and library rows:** Semantic tool articles pair code-drawn specimens with plain descriptions and specific destination links. Library rows are linked text separated by thin top borders. Workflow diagram labels are annotations, not interactive chips.
- **Shape and motion controls:** Weave, Stack, and Loop are named buttons in a labeled fieldset. The selected shape uses `aria-pressed`, ink fill, and paper text. Unselected shapes and the Pause/Play button use the warm hover fill. Controls have a 40px minimum height. Pause/Play includes an explicit accessible action name.
- **Turn range:** A labeled native range spans 0–360 degrees. A thin track and small circular accent thumb keep it subordinate to the specimen. Changing the range pauses automatic rotation; native keyboard adjustment remains available.
- **ASCII specimen:** Geometry becomes an ASCII rendering in a lazy-loaded React island. Controls appear only when rendering is ready. Reduced motion starts still and disables smooth scrolling and CSS transitions; visitors may explicitly play the form. Offscreen or hidden-document rendering stops continuous frames. Loading, unavailable GPU, rendering failure, and absent JavaScript retain authored static ASCII and ordinary page navigation. The fallback does not simulate the three selectable forms.

The sidecar contains style previews of real controls and destinations, not a second interactive sculpture implementation. No error, disabled, or text-input component system is established here.

## Do's and Don'ts

- Do use the shared material colors and preserve the contrast of ink on workbench or paper.
- Do retain visible keyboard focus, named controls, and the still ASCII fallback.
- Do keep motion optional and pause it when the sculpture is offscreen or the document is hidden.
- Do make tool destinations clear with ordinary links and specific labels.
- Don't add ambient shadows or turn the flat tool shelves into floating cards.
- Don't make GPU rendering or animation necessary to read the page or follow a link.
- Don't infer application forms, disabled states, or validation patterns from this website.
