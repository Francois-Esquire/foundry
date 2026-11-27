# @foundry/lib

Import shared helpers directly from their owning module:

- `@foundry/lib/abort`: `withAbort`, which settles a pending promise early when an `AbortSignal` aborts, with the signal reason or a supplied one.
- `@foundry/lib/paths`: storage spelling, filesystem paths, and resource URIs. Bind a URI scheme once with `resourcePaths(scheme)`.
- `@foundry/lib/digest`: SHA-256 hex digests of text or bytes and canonical JSON digests.
- `@foundry/lib/json`: the `JsonValue` type and canonical JSON serialization.
- `@foundry/lib/encoding`: Base64 conversion, strict UTF-8 decoding, and NUL-aware text detection.
- `@foundry/lib/glob`: POSIX glob matching with `*`, `**`, `?`, and brace alternatives.
- `@foundry/lib/ordering`: locale-independent string-key comparators.
- `@foundry/lib/pagination`: page limits, page construction, and complete traversal through `collectPages`.
- `@foundry/lib/mime`: shared MIME constants and text MIME detection.
- `@foundry/lib/file-classification`: filename classification, `FileClassification`, `FileKind`, `FILE_KINDS`, and `CLASSIFICATION_VERSION`.
- `@foundry/lib/emitter`: portable Web-standard `TypedEmitter` with Node `EventEmitter` semantics (recursive `once` safety, receiver `this` binding, LIFO removal, unhandled `"error"` throw).
- `@foundry/lib/async-scope`: conditional `AsyncScope<T>` primitive (`"node"` / `"bun"` → `AsyncLocalStorage`, `"default"` → pass-through) for best-effort diagnostics and guards.
- `@foundry/lib/process-identity` & `@foundry/lib/instance-identity`: pure process/instance identity types, parsers, comparators, `portableProcess`, and `neverGone`. OS/Node queries (`thisProcess`, `isGone`, `nodeStartedAt`, `processAlive`, `lookProcesses`, `groupMembers`) live under `@foundry/lib/node/process-identity`.
- `@foundry/lib/node/*`: Node/Bun-only filesystem, locking, and process-tracking helpers (`atomic-file`, `file-lock`, `orphans`, `spawn-record`, `process-identity`).
- `@foundry/lib/sqlite`: shared Drizzle SQLite database/transaction types, value-storability guards, batching, upsert helpers, and record fault errors.
- `@foundry/lib/testing/sqlite`: Vitest helpers `createTables` for materializing Drizzle SQLite tables and `libsqlDatabases` for opening, reopening, and cleaning up libSQL test databases. Requires the `@libsql/client` and `vitest` dev dependencies in the consuming package.

These modules have no third-party dependencies or filesystem I/O, except the SQLite helpers which require the optional `drizzle-orm` peer. Storage contracts and structural validation live in `@foundry/core/storage`.
`@foundry/lib/authorization/document` requires the optional Zod peer.

Tests live in `src/test/`, with reusable fixtures in `src/test/helpers/`.
Run `bun run --cwd packages/lib test`, `typecheck`, or `build` from the repo root.
Run lint and formatting checks through the root `lint` and `format` commands.
The build emits declarations; runtime exports resolve to TypeScript source.

## `@foundry/lib/authorization`

One mechanism, no host vocabulary. It never learns that a Capability might be a
filesystem read or an MCP tool: a host declares its own Subject and Capability
types and supplies the adapter that projects them onto an address. That is what
lets one mechanism serve an agent harness, a module kernel, and a CLI without
any of them inheriting the others' concepts.

`@foundry/agents/authorization` is the reference binding — read it alongside this.

### Vocabulary

| Term            | Is                                                                     |
| --------------- | ---------------------------------------------------------------------- |
| **Subject**     | the durable identity authority belongs to                              |
| **Capability**  | a host-owned description of one privileged operation — _not_ authority |
| **Grant**       | affirmative authority for one Subject to exercise one Capability       |
| **Profile**     | declarative configuration, authored, issued to nobody                  |
| **Certificate** | a Profile issued to one Subject by a trusted host                      |
| **Policy**      | the rules used when exact authority does not settle a request          |
| **Authorizer**  | the manager that combines all of it into one Decision                  |
| **Approval**    | a human's resolution of one unresolved Decision                        |

### Building one

```typescript
const authorizer = createAuthorizer({
  addressing, // your Subject + Capability → an address
  grants: createMemoryGrantRepository(),
  policy: { global: "ask", byKind: { "fs.read": "allow" } },
  kindOf: (c) => c.kind, // which mode a Capability looks up under
  events: sink, // optional; synchronous, returns nothing
});
```

`policy` takes a fixed rule set **or** a live source with a synchronous
`current()`. Synchronous on purpose: the Authorizer snapshots the whole Policy
before its first `await`, so one decision cannot answer its deny tier from one
configuration and its global tier from another when a settings write lands
mid-lookup.

### The decision

```typescript
interface Authorizer<S, C> {
  decide(request): Promise<AuthorizationDecision>;
  claim(request, decision): Promise<AuthorizationClaim>;
  resolveApproval(request, resolution): Promise<AuthorizationDecision>;
}
```

`decide` runs four tiers in order and stops at the first that settles:

1. **Exact deny** — a host-configured denial of one Subject/Capability pair.
   Beats any authority. Expressed as a rule, not a negative Grant, so
   "forbidden" and "permitted" never share a table.
2. **Live Grant** — whoever issued it. Revoked and expired authority is already
   absent; a session Grant must match the request's `scopeId`. When several
   apply, the durable one is used first so a leftover one-shot is not spent for
   nothing.
3. **Kind mode** — this Capability kind's configured `byKind` entry.
4. **Global mode** — unless the kind is in `failClosed`, which denies instead.

`failClosed` names kinds whose shape tells Policy nothing about what the effect
does, so a blanket `"allow"` written for understood kinds cannot reach them.

```typescript
type AuthorizationDecision =
  | {
      kind: "allow";
      source: "grant" | "approval" | "kind-policy" | "global-policy";
      grantId?;
      grantRevision?;
    }
  | { kind: "deny"; source: "policy" | "approval"; reason: string }
  | { kind: "requires-approval" };
```

`requires-approval` names the result without pretending a wait has begun. This
module owns no suspend port; a composition-layer adapter is what turns it into
an execution suspension.

### decide vs claim

The split is load-bearing. A one-shot Grant is consumed by being taken, and the
agent path evaluates every tool call twice by design — once in the AI SDK's
`needsApproval` predicate, once defensively before executing. Individually fine,
jointly a bug: an evaluation that consumed authority would spend the Grant
before the real invocation ran.

So **`decide` is repeatable and consumes nothing.** **`claim` runs once at the
effect boundary** and is idempotent by `invocationId`, which must be stable
across replays of the same call. Anything short of an allow reaching `claim` is
a denial — including an unresolved `requires-approval`, because a caller that
skipped the approval step gets no benefit of the doubt.

### Addresses

```typescript
interface AuthorizationSubject {
  namespace: string;
  id: string;
  version?: number;
}
interface CapabilityAddress {
  namespace: string;
  id: string;
  version: number;
  constraintsDigest?: string;
}
interface AuthorizationAddressing<S, C> {
  addressOf(subject: S, capability: C): AuthorizationAddress<S>;
}
```

The addressing adapter is deliberately the _only_ way an address is produced —
an untrusted caller supplying one directly could assert a Subject/Capability
relationship the host never sanctioned.

Two versions, two meanings. `Subject.version` separates generations of the same
id, so a re-authored agent preset does not inherit the old one's authority.
`CapabilityAddress.version` is the capability **schema** version: bumping it
means the shape of what is granted changed, so prior grants must not carry over.

`encodeAddress` produces the stable string key.

### Grants and repositories

```typescript
type GrantLifetime =
  | { kind: "once" }
  | { kind: "session"; scopeId: string }
  | { kind: "persistent" };

type GrantProvenance = "human" | "profile" | "certificate" | "system";
```

A session Grant carries its `scopeId` in the lifetime itself — one that cannot
name its session is persistent authority wearing a shorter name.

```typescript
interface GrantRepository<S, C> {
  issue(input: GrantInput<S, C>): Promise<Grant<S, C>>;
  find(address, now): Promise<readonly Grant<S, C>[]>;
  revoke(grantId, expectedRevision?): Promise<void>;
  revokeIssuance(issuanceKey): Promise<void>;
  claimOnce(grantId, invocationId): Promise<GrantClaim>;
}
```

A repository, not a ledger: `find` answers "what is true now" rather than
folding history — history is `events.ts`. Async at the interface even though the
reference adapter is a map, so adopting a durable store later is not a contract
change.

`revoke` is idempotent without an expectation. Pass `expectedRevision` to assert
the Grant has not moved; anything that touched it since throws
`GrantRevisionError` rather than reporting a success the caller did not cause.
`claimOnce` throws `GrantClaimError` when the Grant cannot back the invocation,
so the Authorizer can turn a lost race into a denial instead of a crash.

`issue` accepts an optional `issuanceKey`, stored on the Grant. Once `issue` has
been called with a key, whether it resolved or rejected, `revokeIssuance(key)`
withdraws whatever that call published. An `issue` can store its Grant and then
fail, so this reaches a Grant whose id the caller never learned. Like `revoke`,
it succeeds when nothing is live under the key.

`createMemoryGrantRepository()` and `createMemoryCertificateRepository()` are
the reference adapters.

### Profiles and certificates

```typescript
const certificate = certificateForProfile({
  id,
  issuer,
  subject,
  profile,
  issuedAt,
});
await certificates.issue(certificate); // → the Grants it confers
```

A Profile carries no Subject — it is a template nobody holds yet, and its
`version` stops an edited Profile from silently applying to Certificates already
issued. `certificateForProfile` is construction only; the Certificate confers
nothing until a repository issues it.

Issuance, version, expiry, and revocation are not optional at any stage. A
Certificate that cannot be revoked is a configuration file with a more confident
name.

### Events

```typescript
type AuthorizationEventKind =
  | "issued"
  | "approved"
  | "denied"
  | "revoked"
  | "expired"
  | "claimed"
  | "exercised";

interface AuthorizationEventSink<S, C> {
  emit(event: AuthorizationEvent<S, C>): void;
}
```

`claimed` is one invocation taking authority; `exercised` is the effect actually
running. They are separate because a claim never exercised is precisely the
signal that something broke between authorization and execution.

The sink is synchronous and returns nothing. A thrown error can propagate to
the caller, including after authority has changed. A sink needing asynchronous
durability must buffer internally.

---

## Notes

### Renderer safety

`@foundry/lib/authorization` is renderer-importable and must stay that way —
an approval UI reaches the vocabulary through it, and an unbundled ESM graph
evaluates every re-export on the way in. **Nothing on that barrel may import a
node builtin, directly or transitively.** A `node:crypto` import anywhere in the
graph throws in a browser before any of it runs, whether or not the function is
ever called.

### Entry points

Every public subpath is declared explicitly in `package.json` `exports` (no
`./*` wildcards). Pure Web-standard helpers live at top-level subpaths and under
`./authorization/*`; Node/Bun-only adapters live under `./node/*`; `@foundry/lib/async-scope`
uses conditional `"node"` / `"bun"` vs. `"default"` exports.
Types resolve from `dist/`, not `src/`. Rebuild this package before a consumer
typechecks against a changed public API.
