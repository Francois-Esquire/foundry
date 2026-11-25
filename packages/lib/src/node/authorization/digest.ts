import { createHash } from "node:crypto";

import type {
  AuthorizationAddress,
  AuthorizationSubject,
} from "../../config/authorization/address";
import { encodeAddress } from "../../config/authorization/address";

export function addressDigest<S extends AuthorizationSubject>(
  address: AuthorizationAddress<S>
): string {
  return createHash("sha256")
    .update(encodeAddress(address))
    .digest("hex")
    .slice(0, 32);
}
