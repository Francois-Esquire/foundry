import { isGone, type ProcessIdentity, sameProcess } from "./process-identity";

export interface InstanceIdentity extends ProcessIdentity {
  readonly instanceId?: string;
}

export interface LiveInstance extends ProcessIdentity {
  readonly instanceId: string;
}

const live = new Set<string>();

export function openInstance(
  identity: ProcessIdentity,
  instanceId: string = crypto.randomUUID()
): LiveInstance {
  live.add(instanceId);
  return { ...identity, instanceId };
}

export function closeInstance(instance: LiveInstance): void {
  live.delete(instance.instanceId);
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
  processGone: (owner: ProcessIdentity) => boolean = isGone
): boolean {
  if (owner.instanceId !== undefined && live.has(owner.instanceId)) {
    return false;
  }
  if (sameProcess(owner, self)) {
    return owner.instanceId !== undefined;
  }
  return processGone(owner);
}
