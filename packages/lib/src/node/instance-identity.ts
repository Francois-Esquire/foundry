import {
  type InstanceIdentity,
  instanceGone as pureInstanceGone,
} from "../instance-identity";
import { isGone, type ProcessIdentity } from "./process-identity";

export type { InstanceIdentity, LiveInstance } from "../instance-identity";
// biome-ignore lint/performance/noBarrelFile: Declared Node adapter entry point re-exporting pure instance-identity helpers alongside the Node adapter.
export {
  closeInstance,
  openInstance,
  sameInstance,
} from "../instance-identity";

export function instanceGone(
  owner: InstanceIdentity,
  self: InstanceIdentity,
  processGone: (owner: ProcessIdentity) => boolean = isGone
): boolean {
  return pureInstanceGone(owner, self, processGone);
}
