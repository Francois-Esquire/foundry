import type { ModuleEditorDeclaration } from "@foundry/modules/manifest";
import type { ModuleStore } from "@foundry/modules/store/contract";
import type { ModuleLibrary } from "~/main/modules/library";
import { ensureModuleInstallation } from "~/main/modules/runtime/installation";
import { publishStrict } from "./module-build";

/**
 * A Module whose installed release declares `editors`, each on its own View
 * titled after the View name.
 */
export async function installEditorModule(
  storage: { modules: ModuleLibrary; moduleStore: ModuleStore },
  name: string,
  editors: ModuleEditorDeclaration[],
  options: { installed?: boolean } = {}
) {
  const module = await storage.modules.create(name);
  const views = Object.fromEntries(
    editors.map((editor) => [
      editor.view,
      { path: `/${editor.view}`, title: `${name} ${editor.view}` },
    ])
  );
  const version = await publishStrict(storage.modules, module.id, "1.0.0", {
    editors,
    views: { home: { path: "/", title: name }, ...views },
  });
  if (options.installed !== false) {
    await ensureModuleInstallation(storage.moduleStore, version, new Date());
  }
  return module;
}
