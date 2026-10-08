import { parseModuleManifest } from "../manifest";
import { generateModuleGatewayClient as generateClient } from "../sdk/generator-core";
import type { ModuleCapabilityCatalog } from "./types";

// biome-ignore lint/performance/noBarrelFile: The generator implementation lives in sdk/generator-core because it ships inside the emitted SDK; this module is its host entry, so hosts take the output path and error type from here with the function that uses them.
export {
  GatewayGenerationError as ModuleGatewayGenerationError,
  MODULE_GATEWAY_GENERATED_PATH,
} from "../sdk/generator-core";

/** Generates the selected typed client after canonical Manifest validation. */
export function generateModuleGatewayClient(input: {
  readonly manifest: unknown;
  readonly catalog: ModuleCapabilityCatalog;
}): string {
  return generateClient({
    catalog: input.catalog,
    manifest: parseModuleManifest(input.manifest),
  });
}
