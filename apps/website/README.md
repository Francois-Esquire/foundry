# foundry.sh

Foundry's website: "Tools that come apart. On purpose." A warm
workshop for exploring the open-source local tools, their underlying libraries,
and the broader creation-tooling idea. Documentation stays in the separate Blume
site.

From the repository root:

```sh
bun install --frozen-lockfile
bun run dev --filter=@foundry/website
bun run build --filter=@foundry/website
bun run typecheck --filter=@foundry/website
```

To preview the production output:

```sh
cd apps/website
bun run preview
```

The app participates in the existing root build and typecheck tasks. It needs no
environment variables or server runtime. If configurable environment values are
added, load and validate them through Varlock.

## Content

- `src/pages/index.astro`: the home page; product pages, `404.astro`,
  `robots.txt.ts`, and `sitemap.xml.ts` sit beside it.
- `src/components/exploded-stack.astro`: the hero's exploded drawing of Marbles
  and its libraries.
- `src/examples/`: the Marbles module shown in the walkthrough and its line notes.
- `src/components/ascii-sculpture.tsx` and `ascii-scene.tsx`: the earlier React
  Three Fiber ASCII sculpture, kept for reference but not mounted on the page.
- `src/layouts/site-layout.astro`: metadata, navigation, and footer.
- `src/site.ts`: documentation and repository destinations.
- `src/styles/global.css`: shared layout and design tokens.

Bricolage Grotesque is self-hosted through its Fontsource package. Inter is
self-hosted in `public/fonts/`, with its license in `public/fonts/OFL.txt`.

The Spyglass illustration is conceptual, not a product screenshot. The Astro
config isolates Vite caches by command so type generation cannot replace the
live preview's development React runtime.

## Deployment

Vercel is connected to this repository and deploys pushes to foundry.sh.
Build from the repository root with `bun run build --filter=@foundry/website`
and publish `apps/website/dist`. The canonical URL is `https://foundry.sh`.

The existing GitHub Pages workflow still publishes `apps/documentation/dist`. Keep that
separate documentation deployment intact. The commercial application belongs
in its own repository and can be linked here once it has a destination.
