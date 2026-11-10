/** The script extension's place in the address bar: "#/generate/script-extension". */
const SEGMENT = "script-extension";

export const GENERATE_HASH = "#/generate";

export const SCRIPT_EXTENSION_HASH = `${GENERATE_HASH}/${SEGMENT}`;

/** True when the path below "#/generate" names the script extension. */
export const isScriptExtensionPath = (path: readonly string[]) =>
  path[0] === SEGMENT;
