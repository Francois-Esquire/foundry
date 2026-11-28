import { type ProcessIdentity, sameProcess } from "./process-identity";

export interface InstanceIdentity extends ProcessIdentity {
  readonly instanceId?: string;
}

export interface LiveInstance extends ProcessIdentity {
  readonly instanceId: string;
}

export interface InstanceRegistry {
  close(instance: LiveInstance): void;
  isGone(
    owner: InstanceIdentity,
    self: InstanceIdentity,
    processGone: (owner: ProcessIdentity) => boolean
  ): boolean;
  open(identity: ProcessIdentity, instanceId?: string): LiveInstance;
}

export interface InstanceRegistryOptions {
  readonly id?: () => string;
}

export function createInstanceRegistry(
  options: InstanceRegistryOptions = {}
): InstanceRegistry {
  const live = new Set<string>();
  const generateId = options.id ?? (() => crypto.randomUUID());
  return {
    close(instance) {
      live.delete(instance.instanceId);
    },
    isGone(owner, self, processGone) {
      if (owner.instanceId !== undefined && live.has(owner.instanceId)) {
        return false;
      }
      if (sameProcess(owner, self)) {
        return owner.instanceId !== undefined;
      }
      return processGone(owner);
    },
    open(identity, instanceId = generateId()) {
      live.add(instanceId);
      return { ...identity, instanceId };
    },
  };
}

const defaultRegistry = createInstanceRegistry();

export function openInstance(
  identity: ProcessIdentity,
  instanceId?: string
): LiveInstance {
  return defaultRegistry.open(identity, instanceId);
}

export function closeInstance(instance: LiveInstance): void {
  defaultRegistry.close(instance);
}

export function sameInstance(
  one: InstanceIdentity,
  other: InstanceIdentity
): boolean {
  return (
    sameProcess(one, other) &&
    (one.instanceId === undefined ||
      other.instanceId === undefined ||
      one.instanceId === other.instanceId)
  );
}

export function instanceGone(
  owner: InstanceIdentity,
  self: InstanceIdentity,
  processGone: (owner: ProcessIdentity) => boolean
): boolean {
  return defaultRegistry.isGone(owner, self, processGone);
}
