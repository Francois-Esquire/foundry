import type { CruisedModule } from "./module-graph";

// The module graph of a file map, from the same dependency-cruiser pass as a
// native workspace (`module-cruise.ts`), run by the isolated engine
// (`file-map-cruise-engine.ts`): dist/engine under Bun, inlined into the
// browser analysis asset in a page. The engine is loaded on first use: its `node:fs` is a private
// in-memory volume holding only the map, so nothing outside the map is ever
// read. Modules come back root-relative. The map is data: no configuration,
// plugin or script in it is run. A native workspace scan never comes here;
// it cruises the real checkout (`dependencies.ts`).

export interface FileMapCruiseInput {
  /** Workspace source aliases, as native derivation synthesizes them, with root-relative targets. */
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  /** Root-relative cruise entries (`.` for the whole root), as native derivation lists them. */
  readonly entries: readonly string[];
  /** Repository-relative POSIX paths to text: the files and supplied declarations. */
  readonly files: ReadonlyMap<string, string>;
  /** The normalized POSIX root the map is placed under. */
  readonly root: string;
  /** The repository-relative tsconfig, or undefined for the synthesized alias tsconfig. */
  readonly tsconfig: string | undefined;
}

/** An explicit tsconfig the cruise refuses, as native analysis refuses it. */
export class TsconfigRefusedError extends Error {}

/** Cruise a file map in the isolated engine. */
export async function cruiseFileMap(
  input: FileMapCruiseInput
): Promise<CruisedModule[]> {
  const engine = await import("#file-map-cruise-engine");
  try {
    return await engine.cruiseFileMap(input);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === engine.TSCONFIG_REFUSED
    ) {
      throw new TsconfigRefusedError(error.message, {
        cause: error,
      });
    }
    throw error;
  }
}
