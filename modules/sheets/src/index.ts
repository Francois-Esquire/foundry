/** Where `bun run build` writes the Sheets Module package. */
export const SHEETS_PACKAGE_PATH = new URL(
  "../dist/sheets.module.json",
  import.meta.url
);

export const SHEETS_MODULE_ID = "sheets";
