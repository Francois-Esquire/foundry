import { createHash } from "node:crypto";

import type { AuthorizationAddress, AuthorizationSubject } from "./address";

import { encodeAddress } from "./address";

export function addressDigest<S extends AuthorizationSubject>(
  address: AuthorizationAddress<S>
): string {
  return createHash("sha256")
    .update(encodeAddress(address))
    .digest("hex")
    .slice(0, 32);
}
