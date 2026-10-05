import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AgentGrantRepository,
  AgentSubject,
  Capability,
} from "@foundry/agents/authorization";
import { agentAddressing } from "@foundry/agents/authorization";
import type {
  AuthorizationAddress,
  Grant,
  GrantClaim,
  GrantInput,
} from "@foundry/lib/config/authorization";
import {
  encodeAddress,
  GrantClaimError,
  GrantRevisionError,
} from "@foundry/lib/config/authorization";
import { z } from "zod";

const capabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ domain: z.string(), kind: z.literal("web.fetch") }),
  z.strictObject({
    kind: z.literal("mcp.tool"),
    serverId: z.string(),
    tool: z.string(),
  }),
  z.strictObject({
    kind: z.literal("fs.read"),
    projectId: z.string(),
    root: z.string(),
  }),
  z.strictObject({
    command: z.strictObject({ id: z.string(), version: z.int().nonnegative() }),
    domain: z.string(),
    effect: z.enum(["read", "compute", "write"]),
    kind: z.literal("domain.command"),
    target: z.strictObject({ projectId: z.string(), scope: z.string() }),
  }),
  z.strictObject({
    kind: z.literal("tool.call"),
    source: z.enum([
      "declared",
      "builtin",
      "skill",
      "mcp",
      "mesh",
      "module",
      "harness",
    ]),
    tool: z.string(),
  }),
]);

const grantSchema = z.strictObject({
  address: z.strictObject({
    capability: z.strictObject({
      constraintsDigest: z.string().optional(),
      id: z.string(),
      namespace: z.string(),
      version: z.int().nonnegative(),
    }),
    schema: z.literal("foundry.authorization"),
    subject: z.strictObject({
      id: z.string(),
      namespace: z.literal("agent"),
      version: z.int().nonnegative().optional(),
    }),
    version: z.literal(1),
  }),
  capability: capabilitySchema,
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
  revision: z.int().positive(),
});

const stateSchema = z.strictObject({
  format: z.literal("agent-grants/1"),
  grants: z.array(
    z.strictObject({
      claim: z
        .strictObject({
          grantId: z.string(),
          invocationId: z.string(),
          revision: z.int().positive(),
        })
        .optional(),
      grant: grantSchema,
      revoked: z.boolean(),
    })
  ),
  sequence: z.int().nonnegative(),
});

type GrantState = z.infer<typeof stateSchema>;
type StoredGrant = GrantState["grants"][number];
const transactions = new Map<string, Promise<void>>();
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 10;

function invalidState(): Error {
  return new Error("Saved agent grants are invalid; refusing authorization.");
}

function validateState(value: unknown): GrantState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidState();
  }
  const state = parsed.data;
  if (state.sequence !== state.grants.length) {
    throw invalidState();
  }
  for (const [index, { grant, claim, revoked }] of state.grants.entries()) {
    const address = agentAddressing.addressOf(
      grant.address.subject,
      grant.capability
    );
    if (
      grant.id !== `grant_${String(index + 1)}` ||
      encodeAddress(address) !== encodeAddress(grant.address) ||
      grant.revision !== (revoked ? 2 : 1) ||
      (claim !== undefined &&
        (!revoked ||
          grant.lifetime.kind !== "once" ||
          claim.grantId !== grant.id ||
          claim.revision !== grant.revision))
    ) {
      throw invalidState();
    }
  }
  return state;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readState(path: string): Promise<GrantState> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { format: "agent-grants/1", grants: [], sequence: 0 };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    // biome-ignore lint/style/useErrorCause: JSON parser diagnostics can echo persisted secrets; do not expose file contents.
    throw invalidState();
  }
  return validateState(value);
}

async function writeState(path: string, state: GrantState): Promise<void> {
  const contents = JSON.stringify(validateState(state));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  const deadline = performance.now() + LOCK_WAIT_MS;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const file = await open(lock, "wx", 0o600);
      return async () => {
        await file.close();
        await rm(lock);
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      lastError = error;
      await new Promise<void>((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
  throw new Error(
    `Agent grants are locked at ${lock}; refusing authorization. If no Marbles process is using this store, remove the abandoned lock and retry.`,
    { cause: lastError }
  );
}

async function serialize<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = transactions.get(path) ?? Promise.resolve();
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  transactions.set(path, pending);
  try {
    await previous;
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const unlock = await acquireLock(path);
    try {
      return await operation();
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

function isLive(entry: StoredGrant, now: number): boolean {
  return (
    !entry.revoked &&
    (entry.grant.expiresAt === undefined || entry.grant.expiresAt > now)
  );
}

/** Private durable host authority. An abandoned writer lock fails closed. */
export class JsonAgentGrantRepository implements AgentGrantRepository {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string, options: { readonly now?: () => number } = {}) {
    this.#path = resolve(path);
    this.#now = options.now ?? Date.now;
  }

  issue(
    input: GrantInput<AgentSubject, Capability>
  ): Promise<Grant<AgentSubject, Capability>> {
    return serialize(this.#path, async () => {
      const state = await readState(this.#path);
      state.sequence += 1;
      const grant = grantSchema.parse({
        address: input.address,
        capability: input.capability,
        certificateId: input.certificateId,
        expiresAt: input.expiresAt,
        id: `grant_${String(state.sequence)}`,
        issuedAt: this.#now(),
        lifetime: input.lifetime,
        provenance: input.provenance,
        revision: 1,
      });
      state.grants.push({ grant, revoked: false });
      await writeState(this.#path, state);
      return grant;
    });
  }

  find(
    address: AuthorizationAddress<AgentSubject>,
    now: number
  ): Promise<readonly Grant<AgentSubject, Capability>[]> {
    return serialize(this.#path, async () => {
      const state = await readState(this.#path);
      const key = encodeAddress(address);
      return state.grants
        .filter(
          (entry) =>
            isLive(entry, now) && encodeAddress(entry.grant.address) === key
        )
        .map((entry) => entry.grant);
    });
  }

  claimOnce(grantId: string, invocationId: string): Promise<GrantClaim> {
    return serialize(this.#path, async () => {
      const state = await readState(this.#path);
      const entry = state.grants.find(({ grant }) => grant.id === grantId);
      if (!entry) {
        throw new GrantClaimError(grantId, `Grant ${grantId} does not exist.`);
      }
      // Replay precedes expiry/revocation, exactly as in the reference adapter.
      if (entry.claim) {
        if (entry.claim.invocationId === invocationId) {
          return entry.claim;
        }
        throw new GrantClaimError(
          grantId,
          `Grant ${grantId} is one-shot and was already claimed by another invocation.`
        );
      }
      if (!isLive(entry, this.#now())) {
        throw new GrantClaimError(
          grantId,
          `Grant ${grantId} is revoked or expired.`
        );
      }
      const claim = { grantId, invocationId, revision: entry.grant.revision };
      if (entry.grant.lifetime.kind === "once") {
        claim.revision += 1;
        entry.grant.revision = claim.revision;
        entry.revoked = true;
        entry.claim = claim;
        await writeState(this.#path, state);
      }
      return claim;
    });
  }

  revoke(grantId: string, expectedRevision?: number): Promise<void> {
    return serialize(this.#path, async () => {
      const state = await readState(this.#path);
      const entry = state.grants.find(({ grant }) => grant.id === grantId);
      if (!entry) {
        return;
      }
      if (
        expectedRevision !== undefined &&
        entry.grant.revision !== expectedRevision
      ) {
        throw new GrantRevisionError(
          grantId,
          expectedRevision,
          entry.grant.revision
        );
      }
      if (entry.revoked) {
        return;
      }
      entry.revoked = true;
      entry.grant.revision += 1;
      await writeState(this.#path, state);
    });
  }
}
