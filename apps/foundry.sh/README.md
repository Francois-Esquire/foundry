# foundry.sh

Foundry's global marketing website. A static Astro homepage introduces the
broader creation-tooling vision and today's tools, with links to the existing
Blume documentation. Detailed manifesto and brand work are deferred.

From the repository root:

```sh
bun install --frozen-lockfile
bun run dev --filter=@foundry/website
bun run build --filter=@foundry/website
bun run typecheck --filter=@foundry/website
```

To preview the production output:

```sh
cd apps/foundry.sh
bun run preview
```

The app participates in the existing root build and typecheck tasks. It needs no
environment variables or server runtime. If configurable environment values are
added, load and validate them through Varlock.

## Content

- `src/pages/index.astro`: vision and an introduction to the tools.
- `src/layouts/site-layout.astro`: metadata, navigation, and footer.
- `src/site.ts`: documentation and repository destinations.
- `src/styles/global.css`: shared layout and design tokens.

Inter fonts are self-hosted, carried over from the public foundry.sh site.
Their SIL Open Font License is in `public/fonts/OFL.txt`.

## Deployment

Build from the repository root with `bun run build --filter=@foundry/website`.
Publish `apps/foundry.sh/dist` to a static host. The canonical URL is
`https://foundry.sh`, with root-relative routes and trailing slashes.

The existing GitHub Pages workflow still publishes `docs/dist`. Deploy this app
as a separate site, connect foundry.sh to that host, and verify all documentation
links before switching the domain. Do not replace the documentation artifact
with this app without first arranging a new documentation destination.

No DNS or hosting changes are made by this package. The commercial application
belongs in its own repository and can be linked here once it has a destination.
