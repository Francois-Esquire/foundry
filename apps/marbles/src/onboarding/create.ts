import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isModulePath } from "~/source";
import { renderModule, type SetupDraft } from "./templates";

/** Exclusive writes protect existing modules and concurrent setup attempts. */
export async function createStarter(
  path: string,
  draft: SetupDraft
): Promise<string> {
  const source = renderModule(draft);
  const file = isModulePath(path) ? path : join(path, `${draft.name}.ts`);
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, source, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Module already exists at ${file}. It was not overwritten. Restart Marbles to load it.`,
        { cause: error }
      );
    }
    throw error;
  }
  return file;
}
