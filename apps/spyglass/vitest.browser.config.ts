import { defineConfig } from "vitest/config";

// The scan page's acceptance suite: the built page (`bun run build` first)
// in a real Chromium through playwright-core, with Workers disabled. The
// mocked file needs only the browser; the live file reads pinned public
// repositories from GitHub, unauthenticated, so it needs the network and
// spends about 3 API requests a scan of GitHub's 60 an hour. Neither runs
// in the default `test` task. The page is served from foundry.sh's whole
// built site at /spyglass/scan/ unless `SPYGLASS_SITE` names another
// (`docs` or `package`; see test/browser/helpers/scan-page.ts).
export default defineConfig({
  test: {
    execArgv: ["--no-install"],
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["test/browser/**/*.test.ts"],
    // As vitest.config.ts: Bun drops zod's `z` export from an external module.
    server: { deps: { inline: ["zod"] } },
    testTimeout: 180_000,
  },
});
