import { writeFile } from "node:fs/promises";
import { renderConfig, type SetupDraft } from "./templates";

/** Exclusive creation also protects against a config appearing while setup is open. */
export async function createConfig(
  path: string,
  draft: SetupDraft
): Promise<void> {
  const source = renderConfig(draft);
  try {
    await writeFile(path, source, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Config already exists at ${path}. It was not overwritten. Restart Marbles to load it.`,
        { cause: error }
      );
    }
    throw error;
  }
}
