import type { CruisedModule } from "./module-graph";

export interface FileMapCruiseInput {
  readonly aliases: Readonly<Record<string, readonly string[]>>;

  readonly entries: readonly string[];

  readonly files: ReadonlyMap<string, string>;

  readonly root: string;

  readonly tsconfig: string | undefined;
}

export class TsconfigRefusedError extends Error {}

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
