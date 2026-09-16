/**
 * The storage index for an address — the one authorization module that needs a
 * Node runtime, kept apart from the address grammar for exactly that reason.
 *
 * `./address` is renderer-importable: a host's approval UI imports the
 * authorization vocabulary through `@foundry/agents/authorization`, and a bundler
 * serving unbundled ESM evaluates every re-export on the way. A `node:crypto`
 * import anywhere in that graph therefore throws in a browser before any of it
 * runs, whether or not the digest is ever called. So the digest lives here, off
 * the barrel, reachable only as `@foundry/lib/config/authorization/digest` — an
 * import a renderer cannot make by accident.
 */

import { createHash } from "node:crypto";

import type { AuthorizationAddress, AuthorizationSubject } from "./address";

import { encodeAddress } from "./address";

/**
 * A fixed-width index for an address. **Not an identity.**
 *
 * Storage that cannot hold the structured address in a single indexed column
 * may index this instead, provided it also persists the address itself. Every
 * decision, migration, and explanation reads the address; only lookups read the
 * digest.
 *
 * 32 hex characters (128 bits) — collisions are not a practical concern at that
 * width, and it stays readable in a settings file or a database column.
 */
export function addressDigest<S extends AuthorizationSubject>(
  address: AuthorizationAddress<S>
): string {
  return createHash("sha256")
    .update(encodeAddress(address))
    .digest("hex")
    .slice(0, 32);
}
