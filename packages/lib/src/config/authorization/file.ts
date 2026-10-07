/**
 * A durable {@link GrantRepository}: every Grant in one JSON file, with the
 * reference semantics from `./grant-state`.
 *
 * Each operation is one transaction: take the writer lock, read and validate
 * the whole file, apply one transition, write the file atomically (private
 * mode, flushed before the rename), release. Transactions on one path are
 * queued in-process and exclude other processes through an exclusive lock
 * file, so concurrent hosts cannot both spend a one-shot Grant.
 *
 * It fails closed. A file that does not validate, whose addresses disagree
 * with its capabilities, or whose revisions could not have come from the
 * transitions is refused rather than repaired, and a lock left by a crashed
 * writer is reported, never stolen. Errors never echo file contents.
 *
 * Generic like the rest of this module: the host supplies schemas for its
 * Subject and Capability and the addressing adapter that relates them.
 * Node-bound and needs `zod`, so it is kept off the barrel; import it from
 * `@foundry/lib/config/authorization/file`.
 */

import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { hasErrorCode, readJsonFile, writeFileAtomic } from "../../atomic-file";
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
import type { Grant, GrantClaim, GrantInput, GrantRepository } from "./grant";
import type { GrantEntry } from "./grant-state";
import {
  claimGrant,
  grantIdFor,
  isLiveGrant,
  issuedGrant,
  revokeGrant,
} from "./grant-state";

const DEFAULT_LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 10;
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;

export interface FileGrantRepositoryOptions<S extends AuthorizationSubject, C> {
  /** How the host's Subject and Capability become an address; saved addresses are checked against it. */
  readonly addressing: AuthorizationAddressing<S, C>;
  /** Validates a saved Capability. Should be strict: unknown keys are refused. */
  readonly capability: z.ZodType<C>;
  /**
   * The file's format tag, written at the top level and required on read, so
   * a file from another host or version is refused instead of misread.
   */
  readonly format: string;
  /** How long to wait for another writer's lock before refusing. Defaults to 5s. */
  readonly lockWaitMs?: number;
  /** Injected so expiry is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Where the Grants live. Its directory is created private on first use. */
  readonly path: string;
  /** Validates a saved Subject. Should be strict: unknown keys are refused. */
  readonly subject: z.ZodType<S>;
}

interface SavedGrants<S extends AuthorizationSubject, C> {
  readonly format: string;
  readonly grants: GrantEntry<S, C>[];
  readonly sequence: number;
}

/** Transactions queued per resolved path, across every repository instance in this process. */
const transactions = new Map<string, Promise<void>>();

function refused(): Error {
  return new Error("Saved grants are invalid; refusing authorization.");
}

function savedGrantsSchema<S extends AuthorizationSubject, C>(
  options: FileGrantRepositoryOptions<S, C>
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
    issuedAt: z.number(),
    lifetime: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("once") }),
      z.strictObject({ kind: z.literal("session"), scopeId: z.string() }),
      z.strictObject({ kind: z.literal("persistent") }),
    ]),
    provenance: z.enum(["human", "profile", "certificate", "system"]),
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

async function acquireLock(
  path: string,
  waitMs: number
): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  const deadline = performance.now() + waitMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const file = await open(lock, "wx", PRIVATE_FILE);
      return async () => {
        await file.close();
        await rm(lock);
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      lastError = error;
      await new Promise<void>((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
  throw new Error(
    `Grants are locked at ${lock}; refusing authorization. If no process is using this store, remove the abandoned lock and retry.`,
    { cause: lastError }
  );
}

/** One file of Grants. See the module comment for its guarantees. */
export class FileGrantRepository<S extends AuthorizationSubject, C>
  implements GrantRepository<S, C>
{
  readonly #path: string;
  readonly #now: () => number;
  readonly #lockWaitMs: number;
  readonly #addressing: AuthorizationAddressing<S, C>;
  readonly #format: string;
  readonly #schema: ReturnType<typeof savedGrantsSchema<S, C>>;

  constructor(options: FileGrantRepositoryOptions<S, C>) {
    this.#path = resolve(options.path);
    this.#now = options.now ?? Date.now;
    this.#lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
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

  /** Lock, read, apply, write when changed, unlock — queued behind earlier transactions on this path. */
  async #transaction<T>(
    apply: (saved: SavedGrants<S, C>) => {
      readonly changed: boolean;
      readonly result: T;
      readonly saved?: SavedGrants<S, C>;
    }
  ): Promise<T> {
    const path = this.#path;
    const previous = transactions.get(path) ?? Promise.resolve();
    const { promise: pending, resolve: release } =
      Promise.withResolvers<void>();
    transactions.set(path, pending);
    try {
      await previous;
      await mkdir(dirname(path), {
        mode: PRIVATE_DIRECTORY,
        recursive: true,
      });
      const unlock = await acquireLock(path, this.#lockWaitMs);
      try {
        const current = await this.#read();
        const outcome = apply(current);
        if (outcome.changed) {
          await this.#write(outcome.saved ?? current);
        }
        return outcome.result;
      } finally {
        await unlock();
      }
    } finally {
      release();
      if (transactions.get(path) === pending) {
        transactions.delete(path);
      }
    }
  }

  async #read(): Promise<SavedGrants<S, C>> {
    let value: unknown;
    try {
      value = await readJsonFile(this.#path);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // No cause: JSON parser diagnostics can echo persisted secrets.
        throw refused();
      }
      throw error;
    }
    if (value === undefined) {
      return { format: this.#format, grants: [], sequence: 0 };
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

  async #write(saved: SavedGrants<S, C>): Promise<void> {
    // What was read validated, so a failure here is the new Grant: refuse to
    // write a file this adapter would then refuse to read back.
    const valid = this.#validate(saved);
    if (!valid) {
      throw new Error(
        "Grant does not fit this repository's schemas; nothing was stored."
      );
    }
    await writeFileAtomic(this.#path, JSON.stringify(valid), {
      fsync: true,
      mode: PRIVATE_FILE,
    });
  }
}
