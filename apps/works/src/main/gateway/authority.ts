import { admitRuntimeContext } from "@foundry/modules/gateway/runtime-context";
import {
  ModuleGatewayError,
  type ModulePrincipal,
} from "@foundry/modules/gateway/types";
import { isGranted } from "@foundry/modules/grants";
import type {
  ModuleGatewayContext,
  ModuleStore,
} from "@foundry/modules/store/contract";
import { denied } from "./provider-kit";

/** A Grant an effect needs: the capability and its resolved digest. */
export interface RequiredGrant {
  readonly capability: string;
  readonly digest: string;
}

/**
 * The caller's authority, read again from host state when its effect takes
 * its turn: the package's runtime admission (the Program is the live
 * realization of a running Installation), and every named Grant. A revoke
 * that committed first refuses the effect.
 */
export async function authorizeRuntime(
  store: Pick<ModuleStore, "loadGatewayContext">,
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
