# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static Astro site in `apps/foundry.sh`, integrated with Bun and Turborepo.
All page content is server-rendered into static HTML. The previous React Three
Fiber sculpture is not mounted on the homepage; its source remains for reference.

## Product purpose

Foundry is a creator-centric collection of open-source local tools and libraries:
we are crafting the tools for crafting. The website is one scrolling page.
Its primary outcome is for visitors to explore and use the tools. The broader
vision connects them: people can shape the way they work, take tools apart,
and make them their own. Running tools on your own machine and working with
your own files are central to the message. Developer tools are today's starting
point. Local execution does not imply that every integration works offline.

The visual idea is an exploded assembly drawing: the page shows its tools pulled
apart into real parts. The hero pairs the headline with a line drawing of
Marbles exploded into six of the shared libraries it imports, each labeled with its real
package name. The drawing must stay true to the package graph; update it if
Marbles' dependencies change. Parts are not numbered. The hero headline is "Tools that come apart. On purpose."
The sentence "Foundry builds local, open-source tools for working with agents,
creating things, and understanding code." is supporting copy under the headline,
set in body type. It is not the headline.

The through-line: Foundry turns things people normally accept as given (an
automation, a codebase's shape, an editor) into things they can open up and
change. Local and open source are the preconditions. Each product proves the
idea in its own terms; the hero names what they share.

One level owns the expressive display treatment: the hero headline. Product
headlines are the second level. Product names are small labels above their
headline. Section headings are labels.

Products have separate sections in the order Marbles, Spyglass, Works:
- Marbles: "Agentic infrastructure, unpacked." The example is a real authoring
  module (src/examples/marbles-assess.ts.txt, rendered as a dark code panel
  with line numbers and four numbered notes pinned to the lines they explain;
  src/examples/marbles-walkthrough.ts fails the build if a note's line is
  missing): a
  polling monitor on incidents.md starts an `assess` step; a Codex agent answers
  in text; the step parses and validates `{ isIncident, reason }` with zod; an
  ordinary TypeScript if finishes the run or writes an investigation brief as
  an artifact. The monitor keeps polling. The snippet typechecks against the
  Marbles authoring API but has not been run end to end against Codex. The
  collection workflow that appends reports is referenced in a comment, not shown.
  Do not replace the code with an invented diagram or timeline.
- Spyglass: "Get the lay of your code." A landscape of files, packages, and dependencies
  helps readers investigate architecture. Findings are signals to inspect.
- Works: "Make something. Make the tool fit." Coming soon, so it sits last. The
  intended experience creates documents, images, videos, and apps through
  customizable modules. The document editor and citation checker are an example
  of what someone could build, not a claim that these editors have shipped.

Below the products: a parts list of the shared libraries, a table with each
package name, a plain description, and which tools use it (Spyglass uses none of
them, so the intro names Marbles and Works), then an About Foundry section headed
"Nothing leaves your machine unless you say so." with the README's facts (runs on
your machine, state on disk, MIT licensed, built from libraries readable in the
same repository; do not say the private libraries are reusable), then a
closing "Pick a tool. Take it apart." that points to the docs. Earlier slogans
("Make something your way", "Always in the making", "We're crafting the tools
for crafting", "We're starting with code") are retired. Avoid "your way" and
other lines that could describe any product.

The Spyglass illustration is still an invented node graph. It should become a real
render of Spyglass on this repository; the built viewer in docs/public/spyglass did not
finish drawing in headless Chrome, so the image has to be captured some other
way. A whole-site ASCII treatment still needs discussion. The printer metaphor
is rejected.

## Capabilities and constraints

Documentation lives in `docs/`, is built by Blume, and is deployed separately to
`https://francois-esquire.github.io/foundry/` by the existing CI workflow.

The user connected this app to Vercel: pushes deploy to foundry.sh. Changes to
this website therefore become public through the configured Git deployment.

## Evidence on hand

The root README and package READMEs describe the implemented tools and libraries.
Marbles and Spyglass run from the repository. The repository has an MIT license.
Shared libraries are private workspace packages available in the source.
Do not invent customers, usage metrics, or commercial availability. Verify
release status before adding installation or availability claims.

## Open decisions

Color beyond the warm paper and ink palette, motion, and a Works visual remain
open. The page presents today's tools and the direction clearly
without promising future capabilities.
