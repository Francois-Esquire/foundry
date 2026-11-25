import type { ModuleCommands, ModuleGatewayContext } from "../modules";
import type { ModuleRuntimeIdentity } from "./types";
import { ModuleGatewayError } from "./types";

export async function loadRuntimeGatewayContext(
  store: Pick<ModuleCommands, "loadGatewayContext">,
  runtime: ModuleRuntimeIdentity
): Promise<ModuleGatewayContext> {
  const context = await store.loadGatewayContext(runtime.installationId);
  if (context === null) {
    throw staleRuntime(runtime, "Installation does not exist");
  }
  const { installation } = context;
  if (
    installation.generation !== runtime.generation ||
    installation.contentId !== runtime.contentId
  ) {
    throw staleRuntime(runtime, "selection or generation has changed");
  }
  return context;
}

export async function admitRuntimeContext(
  store: Pick<ModuleCommands, "loadGatewayContext">,
  runtime: ModuleRuntimeIdentity
): Promise<ModuleGatewayContext> {
  const context = await loadRuntimeGatewayContext(store, runtime);
  const { status } = context.installation;
  if (status !== "starting" && status !== "active") {
    throw staleRuntime(runtime, `Installation is ${status}`);
  }
  return context;
}

function staleRuntime(
  runtime: ModuleRuntimeIdentity,
  detail: string
): ModuleGatewayError {
  return new ModuleGatewayError(
    "stale-runtime",
    `Runtime Instance ${runtime.runtimeInstanceId} is stale: ${detail}`
  );
}
