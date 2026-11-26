import { attachContainer } from "../../container/facets";
import type {
  ContainerConfig,
  ContainerMountSpec,
  ContainerRuntime,
} from "../../container/runtime";
import { resolveContainerSpec } from "../../container/spec";

export async function bootGuest<TNative>(
  runtime: ContainerRuntime<TNative>,
  config: ContainerConfig = {},
  mounts: readonly ContainerMountSpec[] = []
) {
  const spec = await resolveContainerSpec(config, mounts);
  const instance = await runtime.create(spec);
  const { facets, remove } = attachContainer(instance, spec, {
    mountCapability: false,
  });
  await instance.ensureDirectory(spec.workdir);
  return {
    ...facets,
    native: instance.native,
    readTextFile: async (path: string) =>
      new TextDecoder().decode(await facets.files.readFile(path)),
    [Symbol.asyncDispose]: remove,
  };
}
