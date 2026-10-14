/** Where `bun run build` writes the fixture's Module package. */
export const MARKDOWN_FIXTURE_PACKAGE_PATH = new URL(
  "../dist/markdown-fixture.module.json",
  import.meta.url
);

/** The fixture's Module id, as its package registers it. */
export const MARKDOWN_FIXTURE_MODULE_ID = "markdown-fixture";
