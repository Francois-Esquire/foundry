# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static Astro site in `apps/foundry.sh`, integrated with Bun and Turborepo.

## Product purpose

The global Foundry website at foundry.sh explains the vision, ideas, manifesto,
and technologies, and sends visitors to the documentation. The user confirmed
that the vision leads and the tools provide evidence. Foundry encompasses
creation tooling: developer tools are today's subset, with product and creative
tooling as the next direction. The current task establishes the site; the
manifesto and detailed brand direction will be discussed later.

## Capabilities and constraints

The complementary commercial application will live in another repository.
This website does not implement that application. Namespace changes are deferred.
Documentation currently lives in `docs/`, is built by Blume, and is deployed to
`https://francois-esquire.github.io/foundry/` by the existing CI workflow.

## Evidence on hand

The root README and package READMEs describe the implemented tools and libraries.
Marbles and Atlas run from the repository; the root README says the first npm
release has not shipped. The repository has an MIT license. Do not invent
customers, usage metrics, commercial availability, or release claims.

## Open decisions

The site addresses people making products, creative work, and software. Detailed
audience and manifesto copy remain open. Hosting provider and the timing of the
domain switch remain open. The existing foundry.sh site is reference material
for the idea-to-creation vision, not evidence for commercial or performance claims.
