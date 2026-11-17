import type { ModuleRegistry, ModuleRegistryUnit } from "../../registry";

type Commands = Pick<
  ModuleRegistry,
  "loadModule" | "registerModule" | "retainManifest"
>;

export function faultyRegistry(
  registry: ModuleRegistry,
  faults: (commands: Commands) => Partial<Commands>
): ModuleRegistryUnit<keyof Commands> {
  const over = (target: Commands): Commands => {
    const commands: Commands = {
      loadModule: (id) => target.loadModule(id),
      registerModule: (input) => target.registerModule(input),
      retainManifest: (input) => target.retainManifest(input),
    };
    return { ...commands, ...faults(commands) };
  };
  return {
    ...over(registry),
    transaction: (work) =>
      registry.transaction((inner, effects) => work(over(inner), effects)),
  };
}
