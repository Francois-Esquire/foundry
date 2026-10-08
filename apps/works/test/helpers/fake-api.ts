import { InMemoryArtifactStore } from "@foundry/artifacts";
import { createRouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { WorksApi, WorksClient } from "~/app/api/client";
import { router } from "~/main/api";
import type { RouterContext } from "~/main/api/context";
import {
  createModuleLibrary,
  type ModuleLibrary,
} from "~/main/modules/library";
import { MemoryStore } from "~/main/vault/store";
import { Vault, type VaultOptions } from "~/main/vault/vault";

/**
 * The real router and a real vault over in-memory stores, called in-process
 * instead of over a MessagePort. The renderer tests mock the client module to
 * return this, so the whole UI-to-router path runs without Electron.
 */
export async function openFakeVault(
  options: VaultOptions = { env: {} }
): Promise<Vault> {
  return await Vault.open(
    { secure: new MemoryStore(), settings: new MemoryStore() },
    options
  );
}

export function fakeClient(
  vault: Vault,
  modules: ModuleLibrary = createModuleLibrary(new InMemoryArtifactStore()),
  services: Pick<RouterContext, "builds" | "sessions"> = {}
): WorksClient {
  return createRouterClient(router, {
    context: { ...services, modules, vault },
  });
}

export function fakeApi(
  vault: Vault,
  modules?: ModuleLibrary,
  services?: Pick<RouterContext, "builds" | "sessions">
): WorksApi {
  return createTanstackQueryUtils(fakeClient(vault, modules, services));
}
