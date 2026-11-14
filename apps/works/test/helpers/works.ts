import path from "node:path";
import { ModelManager } from "@foundry.sh/marbles/engine";
import { SystemTheme } from "~/main/system/theme";
import { composeWorks, type WorksOptions } from "~/main/works";
import { fakePrograms } from "./installed-programs";

/**
 * A test over composed Works writes real Module folders and a durable run
 * store: about 2 s alone, more under the full suite's parallel load.
 */
export const COMPOSED_WORKS_TIMEOUT_MS = 30_000;

/**
 * Works composed as main composes it, with its state, Module folders and
 * product files under `directory`. Released Programs run on
 * {@link fakePrograms} (only the VM and the Gateway socket stand in), whose
 * supervisor, dispatcher and mounts come back as `programs`; no model is
 * routed. `options` replaces any other part.
 */
export async function composeTestWorks(
  directory: string,
  options: Partial<WorksOptions> = {}
) {
  let programs: ReturnType<typeof fakePrograms> | undefined;
  const works = await composeWorks({
    artifactRoot: path.join(directory, "artifacts"),
    models: new ModelManager(),
    moduleRoot: path.join(directory, "modules"),
    print: () => undefined,
    programs(runtime) {
      programs = fakePrograms(runtime);
      return Promise.resolve(programs.runtime);
    },
    routes: {
      route: () => {
        throw new Error("No models in this test");
      },
    },
    theme: new SystemTheme(),
    userData: directory,
    ...options,
  });
  if (!programs) {
    throw new Error("The Program runtime was not composed");
  }
  return { programs, works };
}
