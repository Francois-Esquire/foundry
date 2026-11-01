/** Where `bun run build` writes the Documents Module package. */
export const DOCUMENTS_PACKAGE_PATH = new URL(
  "../dist/documents.module.json",
  import.meta.url
);

/** Preserve the original Module identity across the Documents rename. */
export const DOCUMENTS_MODULE_ID = "markdown-fixture";
