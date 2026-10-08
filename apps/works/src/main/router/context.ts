import { os } from "@orpc/server";
import type { ModuleBuilds } from "~/main/modules/builds/controller";
import type { ModuleLibrary } from "~/main/modules/library";
import type { ModuleSessions } from "~/main/modules/runtime/controller";
import type { Vault } from "~/main/vault/vault";

/** What every procedure receives. Supplied once when the port is upgraded. */
export interface RouterContext {
  builds?: ModuleBuilds;
  modules: ModuleLibrary;
  sessions?: ModuleSessions;
  vault: Vault;
}

export const base = os.$context<RouterContext>();
