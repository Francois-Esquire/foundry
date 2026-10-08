import { os } from "@orpc/server";
import type { ModuleLibrary } from "~/main/modules/library";
import type { Vault } from "~/main/vault/vault";

/** What every procedure receives. Supplied once when the port is upgraded. */
export interface RouterContext {
  modules: ModuleLibrary;
  vault: Vault;
}

export const base = os.$context<RouterContext>();
