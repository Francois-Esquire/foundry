import { isStrictModuleManifest } from "@foundry/modules/manifest";
import type { ModuleCommands } from "@foundry/modules/registry";
import type { ModuleLibrary } from "../modules/library";
import { moduleInstallationId } from "../modules/runtime/installation";
import type { EditorRegistration } from "./resolver";

export function installedEditors(options: {
  readonly library: Pick<ModuleLibrary, "details" | "list" | "release">;
  readonly store: Pick<ModuleCommands, "loadGatewayContext">;
}): () => Promise<EditorRegistration[]> {
  const { library, store } = options;
  async function selected(moduleId: string) {
    const context = await store.loadGatewayContext(
      moduleInstallationId(moduleId)
    );
    const contentId =
      context?.installation.contentId ??
      (await library.details(moduleId))?.releases[0]?.contentId;
    return contentId ? library.release(moduleId, contentId) : null;
  }
  return async () => {
    const found = await Promise.all(
      (await library.list()).map(async (module) => {
        const version = await selected(module.id);
        const manifest = version?.manifest;
        if (!(manifest && isStrictModuleManifest(manifest))) {
          return [];
        }
        return (manifest.editors ?? []).map((editor) => ({
          mimeTypes: editor.mimeTypes,
          mode: editor.mode,
          moduleId: module.id,
          moduleName: module.name,
          release: version.contentId,
          view: editor.view,
          viewTitle: manifest.views[editor.view]?.title ?? null,
        }));
      })
    );
    return found.flat();
  };
}
