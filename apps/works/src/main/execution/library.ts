import { WORKS_TASKS } from "~/shared/execution";
import type { ModuleSummary } from "~/shared/modules";
import { OBSERVATION } from "~/shared/observations";
import type { ModuleLibrary } from "../modules/library";
import { observeResult, type WorksExecution } from "./contract";

/**
 * The library's create and import as `system` engine runs: each call is a
 * durable run that calls the library and reports the Module it added, then
 * tells `added`. Saves and releases are runs already, through the library's
 * own `SourceSaves`; reads stay direct.
 */
export function routeModuleLibrary(
  library: ModuleLibrary,
  execution: Pick<WorksExecution, "dispatch">,
  options: {
    /** After a Module was created or imported, outside its run. */
    readonly added?: (moduleId: string) => Promise<void>;
  } = {}
): ModuleLibrary {
  const added = async (module: ModuleSummary) => {
    await options.added?.(module.id);
    return module;
  };
  return {
    ...library,
    create: async (name) =>
      added(
        await execution.dispatch(WORKS_TASKS.create, {}, async (context) => {
          const module = await library.create(name);
          observeResult(context, OBSERVATION.create, {
            artifactId: module.artifactId,
            moduleId: module.id,
          });
          return module;
        })
      ),
    importPackage: async (encoded) =>
      added(
        await execution.dispatch(WORKS_TASKS.import, {}, async (context) => {
          const module = await library.importPackage(encoded);
          observeResult(context, OBSERVATION.import, {
            artifactId: module.artifactId,
            moduleId: module.id,
          });
          return module;
        })
      ),
  };
}
