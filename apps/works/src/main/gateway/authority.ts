import { admitRuntimeContext } from "@foundry/modules/gateway/runtime-context";
import {
  ModuleGatewayError,
  type ModulePrincipal,
} from "@foundry/modules/gateway/types";
import { isGranted } from "@foundry/modules/grants";
import type {
  ModuleCommands,
  ModuleGatewayContext,
} from "@foundry/modules/registry";
import { denied } from "./provider-kit";

export interface RequiredGrant {
  readonly capability: string;
  readonly digest: string;
}

export async function authorizeRuntime(
  store: Pick<ModuleCommands, "loadGatewayContext">,
  principal: ModulePrincipal,
  grants: readonly RequiredGrant[]
): Promise<ModuleGatewayContext> {
  let context: ModuleGatewayContext;
  try {
    context = await admitRuntimeContext(store, principal);
  } catch (error) {
    if (error instanceof ModuleGatewayError && error.code === "stale-runtime") {
      throw denied("This app is no longer running");
    }
    throw error;
  }
  for (const { capability, digest } of grants) {
    if (
      !isGranted(context.grants, {
        capability,
        constraintsDigest: digest,
        version: 1,
      })
    ) {
      throw denied(`${capability} is not approved`);
    }
  }
  return context;
}
