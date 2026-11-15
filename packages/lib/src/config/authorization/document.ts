/**
 * A durable {@link GrantRepository} over one document: every Grant, and the
 * sequence their ids are drawn from, with the reference semantics from
 * `./grant-state`, kept wherever a {@link GrantDocumentStorage} keeps it.
 *
 * Each operation is one transaction of the storage: read and validate the
 * whole document, apply one transition, write it when it changed. The
 * storage excludes every other transaction on the same document, in this
 * process and in others, so concurrent hosts cannot both spend a one-shot
 * Grant.
 *
 * It fails closed. A document that does not parse, does not validate,
 * whose addresses disagree with their capabilities, or whose revisions
 * could not have come from the transitions is refused rather than
 * repaired. Errors never echo the document.
 *
 * Generic like the rest of this module: the host supplies schemas for its
 * Subject and Capability and the addressing adapter that relates them.
 * Needs `zod`, so it is kept off the barrel; import it from
 * `@foundry/lib/config/authorization/document`.
 */

import { z } from "zod";

import type { Exactly } from "../../exactly";
import type {
  AuthorizationAddress,
  AuthorizationAddressing,
  AuthorizationSubject,
} from "./address";
import {
  AUTHORIZATION_ADDRESS_SCHEMA,
  AUTHORIZATION_ADDRESS_VERSION,
  encodeAddress,
} from "./address";
import type {
  Grant,
  GrantClaim,
  GrantInput,
  GrantLifetime,
  GrantProvenance,
  GrantRepository,
} from "./grant";
import type { GrantEntry } from "./grant-state";
import {
  claimGrant,
  grantIdFor,
  isLiveGrant,
  issuedGrant,
  revokeGrant,
} from "./grant-state";

/**
 * Where a {@link DocumentGrantRepository} keeps its document, and how it
 * runs one transaction on it.
 */
export interface GrantDocumentStorage {
  /**
   * Run `apply` on the document as stored, its text, or `undefined` when
   * there is none, excluding every other transaction on it; then store
   * `next` in its place when `apply` returns one. `apply` may throw, and
   * nothing is stored then.
   */
  transact<T>(
    apply: (stored: string | undefined) => {
      readonly next?: string;
      readonly result: T;
    }
  ): Promise<T>;
}

export interface DocumentGrantRepositoryOptions<
  S extends AuthorizationSubject,
  C,
> {
  /** How the host's Subject and Capability become an address; saved addresses are checked against it. */
  readonly addressing: AuthorizationAddressing<S, C>;
  /** Validates a saved Capability. Should be strict: unknown keys are refused. */
  readonly capability: z.ZodType<C>;
  /**
   * The document's format tag, written at the top level and required on
   * read, so a document from another host or version is refused instead of
   * misread.
   */
  readonly format: string;
  /** Injected so expiry is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Where the document is kept. */
  readonly storage: GrantDocumentStorage;
  /** Validates a saved Subject. Should be strict: unknown keys are refused. */
  readonly subject: z.ZodType<S>;
}

interface SavedGrants<S extends AuthorizationSubject, C> {
  readonly format: string;
  readonly grants: GrantEntry<S, C>[];
  readonly sequence: number;
}

const lifetimes = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once") }),
  z.strictObject({ kind: z.literal("session"), scopeId: z.string() }),
  z.strictObject({ kind: z.literal("persistent") }),
]);
const lifetimeSchema: z.ZodType<
  Exactly<z.infer<typeof lifetimes>, GrantLifetime>
> = lifetimes;

const provenances = z.enum(["human", "profile", "certificate", "system"]);
const provenanceSchema: z.ZodType<
  Exactly<z.infer<typeof provenances>, GrantProvenance>
> = provenances;

function refused(): Error {
  return new Error("Saved grants are invalid; refusing authorization.");
}

function savedGrantsSchema<S extends AuthorizationSubject, C>(
  options: DocumentGrantRepositoryOptions<S, C>
) {
  const revision = z.int().positive();
  const grant = z.strictObject({
    address: z.strictObject({
      capability: z.strictObject({
        constraintsDigest: z.string().optional(),
        id: z.string(),
        namespace: z.string(),
        version: z.int().nonnegative(),
      }),
      schema: z.literal(AUTHORIZATION_ADDRESS_SCHEMA),
      subject: options.subject,
      version: z.literal(AUTHORIZATION_ADDRESS_VERSION),
    }),
    capability: options.capability,
    certificateId: z.string().optional(),
    expiresAt: z.number().optional(),
    id: z.string(),
    // Optional so files written before issuance keys existed still load.
    issuanceKey: z.string().optional(),
    issuedAt: z.number(),
    lifetime: lifetimeSchema,
    provenance: provenanceSchema,
    revision,
  });
  return z.strictObject({
    format: z.literal(options.format),
    grants: z.array(
      z.strictObject({
        claim: z
          .strictObject({
            grantId: z.string(),
            invocationId: z.string(),
            revision,
          })
          .optional(),
        grant,
        revoked: z.boolean(),
      })
    ),
    sequence: z.int().nonnegative(),
  });
}

/**
 * Only states the transitions can produce: ids in issue order, addresses that
 * match their capabilities, revision 1 while live and 2 once revoked or
 * claimed, and a claim only on a consumed one-shot Grant.
 */
function isReachable<S extends AuthorizationSubject, C>(
  saved: SavedGrants<S, C>,
  addressing: AuthorizationAddressing<S, C>
): boolean {
  if (saved.sequence !== saved.grants.length) {
    return false;
  }
  return saved.grants.every(({ claim, grant, revoked }, index) => {
    const address = addressing.addressOf(
      grant.address.subject,
      grant.capability
    );
    const claimFits =
      claim === undefined ||
      (revoked &&
        grant.lifetime.kind === "once" &&
        claim.grantId === grant.id &&
        claim.revision === grant.revision);
    return (
      grant.id === grantIdFor(index + 1) &&
      encodeAddress(address) === encodeAddress(grant.address) &&
      grant.revision === (revoked ? 2 : 1) &&
      claimFits
    );
  });
}

/** One document of Grants. See the module comment for its guarantees. */
export class DocumentGrantRepository<S extends AuthorizationSubject, C>
  implements GrantRepository<S, C>
{
  readonly #storage: GrantDocumentStorage;
  readonly #now: () => number;
  readonly #addressing: AuthorizationAddressing<S, C>;
  readonly #format: string;
  readonly #schema: ReturnType<typeof savedGrantsSchema<S, C>>;

  constructor(options: DocumentGrantRepositoryOptions<S, C>) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#addressing = options.addressing;
    this.#format = options.format;
    this.#schema = savedGrantsSchema(options);
  }

  claimOnce(grantId: string, invocationId: string): Promise<GrantClaim> {
    return this.#transaction((saved) => {
      const index = saved.grants.findIndex(({ grant }) => grant.id === grantId);
      const { claim, next } = claimGrant(
        saved.grants[index],
        grantId,
        invocationId,
        this.#now()
      );
      if (next) {
        saved.grants[index] = next;
      }
      return { changed: next !== undefined, result: claim };
    });
  }

  find(
    address: AuthorizationAddress<S>,
    now: number
  ): Promise<readonly Grant<S, C>[]> {
    const key = encodeAddress(address);
    return this.#transaction((saved) => ({
      changed: false,
      result: saved.grants
        .filter(
          (entry) =>
            isLiveGrant(entry, now) &&
            encodeAddress(entry.grant.address) === key
        )
        .map((entry) => entry.grant),
    }));
  }

  issue(input: GrantInput<S, C>): Promise<Grant<S, C>> {
    return this.#transaction((saved) => {
      const sequence = saved.sequence + 1;
      const grant = issuedGrant(input, grantIdFor(sequence), this.#now());
      saved.grants.push({ grant, revoked: false });
      return {
        changed: true,
        result: grant,
        saved: { ...saved, sequence },
      };
    });
  }

  revoke(grantId: string, expectedRevision?: number): Promise<void> {
    return this.#transaction((saved) => {
      const index = saved.grants.findIndex(({ grant }) => grant.id === grantId);
      const next = revokeGrant(saved.grants[index], grantId, expectedRevision);
      if (next) {
        saved.grants[index] = next;
      }
      return { changed: next !== undefined, result: undefined };
    });
  }

  revokeIssuance(issuanceKey: string): Promise<void> {
    return this.#transaction((saved) => {
      let changed = false;
      for (const [index, entry] of saved.grants.entries()) {
        if (entry.grant.issuanceKey !== issuanceKey) {
          continue;
        }
        const next = revokeGrant(entry, entry.grant.id);
        if (next) {
          saved.grants[index] = next;
          changed = true;
        }
      }
      return { changed, result: undefined };
    });
  }

  /** Read, apply, write when changed: one transaction of the storage. */
  #transaction<T>(
    apply: (saved: SavedGrants<S, C>) => {
      readonly changed: boolean;
      readonly result: T;
      readonly saved?: SavedGrants<S, C>;
    }
  ): Promise<T> {
    return this.#storage.transact((stored) => {
      const current = this.#read(stored);
      const outcome = apply(current);
      return outcome.changed
        ? {
            next: this.#written(outcome.saved ?? current),
            result: outcome.result,
          }
        : { result: outcome.result };
    });
  }

  #read(stored: string | undefined): SavedGrants<S, C> {
    if (stored === undefined) {
      return { format: this.#format, grants: [], sequence: 0 };
    }
    let value: unknown;
    try {
      value = JSON.parse(stored);
    } catch {
      // biome-ignore lint/style/useErrorCause: JSON parser diagnostics can echo persisted secrets.
      throw refused();
    }
    const saved = this.#validate(value);
    if (!saved) {
      throw refused();
    }
    return saved;
  }

  #validate(value: unknown): SavedGrants<S, C> | undefined {
    const parsed = this.#schema.safeParse(value);
    if (!(parsed.success && isReachable(parsed.data, this.#addressing))) {
      return;
    }
    return parsed.data;
  }

  #written(saved: SavedGrants<S, C>): string {
    // What was read validated, so a failure here is the new Grant: refuse to
    // write a document this repository would then refuse to read back.
    const valid = this.#validate(saved);
    if (!valid) {
      throw new Error(
        "Grant does not fit this repository's schemas; nothing was stored."
      );
    }
    return JSON.stringify(valid);
  }
}
