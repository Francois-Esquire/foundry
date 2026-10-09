# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static Astro site in `apps/foundry.sh`, integrated with Bun and Turborepo.
A React Three Fiber island renders the interactive ASCII sculpture with
React Postprocessing. All page content is server-rendered into static HTML.

## Product purpose

Foundry is a creator-centric collection of open-source local tools and libraries:
we are crafting the tools for crafting. The website is one scrolling page.
Its primary outcome is for visitors to explore and use the tools. The broader
vision connects them: people can shape the way they work, take tools apart,
and make them their own. Running tools on your own machine and working with
your own files are central to the message. Developer tools are today's starting
point. Local execution does not imply that every integration works offline.

The user chose a warm, tactile workshop for the visual world, with ASCII art
and interactive 3D. The working headline is "Craft the way you work."

## Capabilities and constraints

The complementary commercial application lives outside this website.
Documentation lives in `docs/`, is built by Blume, and is deployed separately to
`https://francois-esquire.github.io/foundry/` by the existing CI workflow.

The user connected this app to Vercel: pushes deploy to foundry.sh. Changes to
this website therefore become public through the configured Git deployment.

## Evidence on hand

The root README and package READMEs describe the implemented tools and libraries.
Marbles and Atlas run from the repository. The repository has an MIT license.
Shared libraries are private workspace packages available in the source.
Do not invent customers, usage metrics, or commercial availability. Verify
release status before adding installation or availability claims.

## Open decisions

Detailed manifesto copy and the wider roadmap remain open. The page presents
today's tools and the direction clearly without promising future capabilities.
