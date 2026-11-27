import type {
  ProcessIdentity,
  ProcessState,
} from "@foundry/lib/process-identity";
import { neverGone, portableProcess } from "@foundry/lib/process-identity";

export interface OwnerLiveness {
  readonly identity: () => ProcessIdentity;
  readonly isGone: (owner: ProcessIdentity) => boolean;
  readonly stateOf?: (owner: ProcessIdentity) => ProcessState;
}

export const PORTABLE_OWNER_LIVENESS: OwnerLiveness = {
  identity: portableProcess,
  isGone: neverGone,
  stateOf: () => "unknown",
};

export function ownerStateOf(
  liveness: OwnerLiveness,
  owner: ProcessIdentity
): ProcessState {
  if (liveness.stateOf !== undefined) {
    return liveness.stateOf(owner);
  }
  return liveness.isGone(owner) ? "gone" : "running";
}
