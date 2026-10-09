# foundry.sh

Foundry's one-page website: "Craft the way you work." A warm workshop for
exploring the open-source local tools, their underlying libraries, and the broader
creation-tooling idea. Documentation stays in the separate Blume site.

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

- `src/pages/index.astro`: the complete one-page site.
- `src/components/ascii-sculpture.tsx`: accessible artwork controls and static fallback.
- `src/components/ascii-scene.tsx`: lazy-loaded React Three Fiber scene with GPU ASCII post-processing.
- `src/layouts/site-layout.astro`: metadata, navigation, and footer.
- `src/site.ts`: documentation and repository destinations.
- `src/styles/global.css`: shared layout and design tokens.

Bricolage Grotesque is self-hosted through its Fontsource package. Inter is
self-hosted in `public/fonts/`, with its license in `public/fonts/OFL.txt`.

The sculpture loads when visible, uses a capped pixel ratio, and stops rendering
when offscreen or the tab is hidden. Reduced motion starts it paused. The static
ASCII fallback remains available without JavaScript, WebGL, or after context loss.
The illustrations for Marbles and Atlas are conceptual, not product screenshots.

Verify the sculpture in both development and production previews: wait for
hydration, change its shape, pause it, and reload. While dev is running, run
`bun run typecheck` and `bun run build`, then reload the dev page and confirm the
sculpture and controls remain visible. A production build alone does not exercise
Vite's development JSX runtime. The Astro config isolates Vite caches by command
so type generation cannot replace the live preview's development React runtime.

## Deployment

Vercel is connected to this repository and deploys pushes to foundry.sh.
Build from the repository root with `bun run build --filter=@foundry/website`
and publish `apps/foundry.sh/dist`. The canonical URL is `https://foundry.sh`.

The existing GitHub Pages workflow still publishes `docs/dist`. Keep that
separate documentation deployment intact. The commercial application belongs
in its own repository and can be linked here once it has a destination.
