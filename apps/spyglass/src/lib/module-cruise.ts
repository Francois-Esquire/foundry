import { cruise } from "dependency-cruiser";
import type { CruisedModule } from "./module-graph";
import { EXCLUDE_PATTERNS } from "./module-graph";

export async function cruiseEntries(
  root: string,
  entries: readonly string[],
  tsconfigFile: string,
  transpileTsConfig: unknown
): Promise<CruisedModule[]> {
  const result = await cruise(
    [...entries],
    {
      baseDir: root,
      doNotFollow: { path: "node_modules" },
      exclude: { path: EXCLUDE_PATTERNS },
      tsConfig: { fileName: tsconfigFile },
      tsPreCompilationDeps: true,
    },
    undefined,
    { tsConfig: transpileTsConfig }
  );
  if (typeof result.output === "string") {
    throw new Error("dependency-cruiser returned an unexpected string output");
  }
  return result.output.modules;
}
