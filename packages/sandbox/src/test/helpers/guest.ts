import type { ContainerDefaults, Driver } from "../../containers/driver";
import { attachContainer } from "../../containers/facets";
import {
  type ContainerSpecInput,
  resolveContainerSpec,
} from "../../containers/spec";

export async function bootGuest<TNative>(
  driver: Driver<TNative>,
  input: ContainerSpecInput = {},
  defaults: ContainerDefaults = {}
) {
  const id = `guest-${globalThis.crypto.randomUUID()}`;
  const spec = resolveContainerSpec({
    defaults,
    input,
    labels: {},
    name: id,
  });
  const handle = await driver.create({
    containerId: id,
    labels: spec.labels,
    name: spec.name,
    spec,
  });
  const { facets, remove } = attachContainer(handle, spec);
  await handle.ensureDirectory(spec.workdir);
  return {
    ...facets,
    native: handle.native,
    readTextFile: async (path: string) =>
      new TextDecoder().decode(await facets.files.readFile(path)),
    [Symbol.asyncDispose]: remove,
  };
}
