import {
  isGone,
  processState,
  thisProcess,
} from "@foundry/lib/node/process-identity";
import type { OwnerLiveness } from "~/lib/recovery/liveness";

export const NODE_OWNER_LIVENESS: OwnerLiveness = {
  identity: thisProcess,
  isGone,
  stateOf: processState,
};
