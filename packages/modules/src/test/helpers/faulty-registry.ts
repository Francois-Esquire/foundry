import type { ModuleRegistry, ModuleRegistryUnit } from "../../registry";

type Commands = Pick<
  ModuleRegistry,
  "loadModule" | "registerModule" | "retainManifest"
>;

/**
 * `registry`, with `faults` replacing some of its commands, both on the
 * registry itself and on the registry each of its transactions hands its
 * work. `faults` receives the commands it replaces, so a fault can call
 * through (and fail after the call committed, say).
 */
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
