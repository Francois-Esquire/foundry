import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { createRouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { WorksApi, WorksClient } from "~/app/api/client";
import { router } from "~/main/api";
import type { RouterContext } from "~/main/api/context";
import { EditorBindings } from "~/main/artifacts/bindings";
import type { EditorPreferences } from "~/main/artifacts/editor-preferences";
import { installedEditors } from "~/main/artifacts/editors";
import { createArtifactExplorer } from "~/main/artifacts/explorer";
import { modulePersistence } from "~/main/modules/artifact-store";
import {
  createModuleLibrary,
  type ModuleLibrary,
} from "~/main/modules/library";
import { MemoryStore } from "~/main/vault/store";
import { Vault, type VaultOptions } from "~/main/vault/vault";
import { unrecordedSaves } from "./source-saves";

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

type Services = Pick<
  RouterContext,
  | "access"
  | "artifacts"
  | "audit"
  | "authoring"
  | "builds"
  | "moduleSettings"
  | "power"
  | "sessions"
  | "theme"
>;

/**
 * A Module library and the Artifact explorer over one in-memory store. The
 * explorer's editors are the installed Modules' declared editors.
 */
export function fakeStorage(
  store = new InMemoryArtifactStore(),
  preferences?: EditorPreferences
) {
  const artifacts = new ArtifactManager({ store });
  const modules = createModuleLibrary(store, { saves: unrecordedSaves });
  const moduleStore = modulePersistence(store).modules;
  return {
    artifacts,
    explorer: createArtifactExplorer(artifacts, {
      bindings: new EditorBindings(),
      editors: installedEditors({ library: modules, store: moduleStore }),
      // Renderer tests create no product files and open none for writing.
      files: {
        create: () => Promise.reject(new Error("No product files here")),
        working: () => Promise.resolve(null),
      },
      preferences,
    }),
    moduleStore,
    modules,
  };
}

export function fakeClient(
  vault: Vault,
  modules?: ModuleLibrary,
  services: Services = {}
): WorksClient {
  const storage = modules ? { modules } : fakeStorage();
  return createRouterClient(router, {
    context: {
      ...("explorer" in storage ? { artifacts: storage.explorer } : {}),
      ...services,
      modules: storage.modules,
      vault,
    },
  });
}

export function fakeApi(
  vault: Vault,
  modules?: ModuleLibrary,
  services?: Services
): WorksApi {
  return createTanstackQueryUtils(fakeClient(vault, modules, services));
}
