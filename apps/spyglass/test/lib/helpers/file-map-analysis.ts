import type { FileMapCapabilities } from "../../../src/lib/dataset-analysis";
import type { FileMapDatasetInput } from "../../../src/lib/file-map-dataset";
import type { PreparedFileMap } from "../../../src/lib/file-map-preparation";
import {
  analyzeFileMapWorkspace,
  prepareFileMap,
} from "../../../src/lib/file-map-preparation";
import { analyzePreparedPackageLocal } from "../../../src/lib/package-local-analysis";
import type { PackageLocalReport } from "../../../src/lib/package-local-types";
import type { WorkspaceSurfaceDerivation } from "../../../src/lib/workspace-derive-types";

export interface FileMapAnalysis {
  capabilities: FileMapCapabilities;
  derivation: WorkspaceSurfaceDerivation;
  locals: PackageLocalReport[];
  prepared: PreparedFileMap;
  timing: Record<string, number>;
}

export async function analyzeFileMap(
  input: Omit<FileMapDatasetInput, "command" | "repository" | "settings">
): Promise<FileMapAnalysis> {
  const prepared = await prepareFileMap(input);
  const timing: Record<string, number> = { ...prepared.timing };
  const locals = prepared.locals.map((source) =>
    analyzePreparedPackageLocal(source, input.config)
  );
  const derivation = analyzeFileMapWorkspace(
    prepared,
    locals,
    input.config,
    timing
  );
  return {
    capabilities: prepared.capabilities,
    derivation,
    locals,
    prepared,
    timing,
  };
}
