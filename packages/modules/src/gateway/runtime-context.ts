import type { ModuleGatewayContext, ModuleStore } from "../store/contract";
import type { ModuleRuntimeIdentity } from "./types";

import { ModuleGatewayError } from "./types";

/**
 * The one runtime staleness policy: a Program may act only while it is the
 * live realization of its Installation's current generation and selection.
 * Admission layers the Installation's runnable status on top of this.
 */
export async function loadRuntimeGatewayContext(
  store: Pick<ModuleStore, "loadGatewayContext">,
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

/**
 * Runtime admission: the staleness policy, and an Installation that is
 * starting or running. Every effect a Program asks for is admitted here.
 */
export async function admitRuntimeContext(
  store: Pick<ModuleStore, "loadGatewayContext">,
  runtime: ModuleRuntimeIdentity
): Promise<ModuleGatewayContext> {
  const context = await loadRuntimeGatewayContext(store, runtime);
  const { status } = context.installation;
  if (status !== "starting" && status !== "active") {
    throw staleRuntime(runtime, `Installation is ${status}`);
  }
  return context;
}

export function staleRuntime(
  runtime: ModuleRuntimeIdentity,
  detail: string
): ModuleGatewayError {
  return new ModuleGatewayError(
    "stale-runtime",
    `Runtime Instance ${runtime.runtimeInstanceId} is stale: ${detail}`
  );
}
