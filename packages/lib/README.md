# @foundry/lib

Shared readable-name, resource-URI, configuration, and authorization primitives.

The root entry point exports `generateReadableName`, `createResourceUrl`,
`formatResourceUrl`, `parseResourcePath`, `parseResourceUrl`, and `ResourceUriError`.
Configuration and authorization use the subpaths documented below.

Tests live in `src/test/`, with reusable fixtures in `src/test/helpers/`.
Run `bun run --cwd packages/lib test`, `typecheck`, or `build` from the repo root.
Run lint and formatting checks through the root `lint` and `format` commands.
The build emits declarations; runtime exports resolve to TypeScript source.

## Configuration and authorization

Two independent primitives that hosts wire together:

- **Config** — a VS Code-style settings store. Packages contribute typed,
  schema-validated slices; anyone reads by dot-path and subscribes at any
  granularity.
- **Authorization** — the capability authorization mechanism. One Authorizer,
  one Grant model, one Decision. It knows no host vocabulary.

They share no code and no types. See [Why both live here](#why-both-live-here).

## Quick start

A package contributes its slice, then anyone reads it typed.

```typescript
import { z } from "zod";

import { Config } from "@foundry/lib/config";

const schema = z.object({
  worktreesSubdir: z.string(),
  scan: z.object({ maxDepth: z.number() }),
});

declare module "@foundry/lib/config/types" {
  interface ConfigShape {
    workspaces?: z.infer<typeof schema>;
  }
}

const config = new Config();
config.contribute("workspaces", schema, {
  worktreesSubdir: ".worktrees",
  scan: { maxDepth: 3 },
});

config.get("workspaces.scan.maxDepth"); // 3, typed as number
config.set("workspaces.scan.maxDepth", 5); // validated; throws on a bad write

config.on("workspaces.scan.maxDepth", ({ before, after, source }) => {
  console.log(before, "→", after, `(${source})`);
});
```

The `declare module` block is what makes `get` and `set` typed without a
per-call generic. Without it everything still works, untyped.

The host owns persistence at both ends:

```typescript
config.loadFromData(await store.read()); // ingest a pre-parsed payload
await store.write(config.snapshot()); // persist however you like
```

## How it comes together

```
ReactiveStore     storage, dot-path get/set, leaf + glob events
  Config          + zod validation per prefix, defaults, whole-prefix events,
                    a source tag, and two ownership models

Credentials       a sibling, not a prefix — secrets never enter the store
```

**Config is IO-free.** It never reads or writes disk. The desktop app ingests
from its own store, the CLI from a file it scanned, both through
`loadFromData`. Persistence is `snapshot()` and whatever the host does with it.
That is the entire integration surface, and it is why the same Config runs in
the main process and in a test with no filesystem.

**Two ownership models, distinguished by who holds the values:**

|            | `contribute(prefix, schema, defaults)` | `mount(prefix, child)`  |
| ---------- | -------------------------------------- | ----------------------- |
| Storage    | this Config                            | the child store         |
| Validation | the prefix schema                      | the child's own         |
| On write   | validated and committed here           | delegated to the child  |
| On detach  | n/a                                    | child stays fully alive |

A prefix can be one or the other, never both — `contribute` on a mounted prefix
throws, and so does the reverse. Mounting a _different_ child over an existing
one warns and overrides; the displaced child keeps its data and its owner.

---

## `@foundry/lib/config`

```typescript
class Config extends ReactiveStore<Record<string, unknown>> {
  contribute<T>(prefix: string, schema: ZodType<T>, defaults: T): void;
  mount(prefix: string, child: ReactiveStore<Record<string, unknown>>): void;
  detach(prefix: string): void;
  contributed(): readonly string[];

  get<P extends Path>(path: P): ValueAt<ConfigShape, P>;
  set<P extends Path>(path: P, value: ValueAt<ConfigShape, P>): void;
  merge(patch: Partial<ConfigShape> | Record<string, unknown>): void;
  reset(prefix?: string): void;

  loadFromData(data: Partial<ConfigShape>): LoadedPayload;
  snapshot(): { [K in keyof ConfigShape]: ConfigShape[K] };
}
```

Prefixes are a single segment — `"workspaces"`, never `"a.b"`. Paths below them
are dot-notation and go as deep as the schema does.

### Reads and writes

`get("workspaces")` returns the whole prefix object; `get("workspaces.scan.maxDepth")`
returns the leaf; a missing segment returns `undefined`.

`set` deep-writes, then validates the **entire prefix**. On failure the stored
value is untouched and the call throws — a rejected write leaves no partial
state. `merge` groups an object patch by prefix and validates each in turn;
an unknown prefix warns and is skipped rather than throwing, because a payload
from disk routinely carries keys this process never registered.

`reset()` with no argument restores defaults for every _contributed_ prefix and
leaves mounted children alone — they are independently owned, so reset them
through their owner.

### Events

Three granularities. Same payload; the event **name** picks the level.

```typescript
config.on("workspaces.scan.maxDepth", handler); // exact leaf
config.on("workspaces.*", handler); // once per changed leaf
config.on("workspaces", handler); // once per prefix commit
config.on("loaded", ({ applied }) => {}); // after loadFromData
```

```typescript
interface ConfigChangePayload {
  path: string; // the leaf for leaf/glob events, the prefix for prefix events
  before: unknown;
  after: unknown;
  source: "set" | "merge" | "reset" | "load";
}
```

`source` is what lets a subscriber tell a caller-driven mutation from a
load-driven one — the usual reason being to not echo a save back to disk.

Mounted children relay through the same events under their prefix, with the
child's own `source` riding along.

## `@foundry/lib/config/reactive-store`

`Config`'s base class, and usable alone as the child in a `mount`.

```typescript
class ReactiveStore<T extends object> extends EventEmitter {
  get values(): Readonly<T>;
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  patch(patch: DeepPartial<T>): void;
  reset(): void;
  attachRelay(relay: CommitRelay<T> | null): void;
}
```

Storage, dot-path access, and leaf + glob events with no schema layer. Note the
`undefined` semantics differ from `Config`: here `set(path, undefined)` **deletes**
the leaf, which is the flat-bag intuition. Under a schema-validated prefix an
undefined leaf is left in place for Zod to strip. Both helpers exist in
`helpers.ts` for exactly that reason; collapsing them breaks one contract.

`attachRelay` is the mount seam — `Config.mount` uses it to forward the child's
commits, and `detach` severs it.

## `@foundry/lib/config/credentials`

Runtime-only secrets. Deliberately _not_ a Config prefix.

```typescript
declare module "@foundry/lib/config/credentials" {
  interface CredentialsVault {
    anthropicApiKey?: string | null;
  }
}

const creds = new Credentials();
creds.set({ anthropicApiKey: "sk-…" }); // null clears, undefined leaves alone
creds.get(); // Readonly<CredentialsVault>
creds.clear();
creds.on("changed", ({ before, after }) => {});
```

Persistence is a non-goal. The class owns an in-memory snapshot, shallow-merge
mutation, and a `"changed"` event; the host owns how secrets land (desktop
`safeStorage`, CLI env) and how they are cleared. Keeping them out of the
config store is what stops a secret riding along in `snapshot()`.

## `@foundry/lib/config/types`

The augmentation surfaces and the path algebra.

```typescript
interface ConfigShape {} // empty by design; every package widens it
type Path<T = ConfigShape>; // every dot-path in T, prefixes and leaves
type ValueAt<T, P extends string>; // the value type at a path
```

`ValueAt` returns `unknown` for a path that does not fit the shape — a
deliberate escape hatch so untyped callers still compile.

---

## `@foundry/lib/config/authorization`

One mechanism, no host vocabulary. It never learns that a Capability might be a
filesystem read or an MCP tool: a host declares its own Subject and Capability
types and supplies the adapter that projects them onto an address. That is what
lets one mechanism serve an agent harness, a module kernel, and a CLI without
any of them inheriting the others' concepts.

`@foundry/agents/consent` is the reference binding — read it alongside this.

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
  grants: createInMemoryGrantRepository(),
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

`encodeAddress` produces the stable string key. `addressDigest` — a 128-bit
index for storage that cannot hold the structured address — lives at
`@foundry/lib/config/authorization/digest`, deliberately **off** the barrel: it
needs `node:crypto`, and the barrel is renderer-importable. See
[Renderer safety](#renderer-safety).

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

`createInMemoryGrantRepository()` and `createInMemoryCertificateRepository()` are
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

The sink is synchronous and returns nothing, so recording history can never add
an `await` to the decision path or fail a decision that already succeeded. A
sink needing durability buffers internally.

---

## Notes

### Renderer safety

`@foundry/lib/config/authorization` is renderer-importable and must stay that way —
an approval UI reaches the vocabulary through it, and an unbundled ESM graph
evaluates every re-export on the way in. **Nothing on that barrel may import a
node builtin, directly or transitively.** A `node:crypto` import anywhere in the
graph throws in a browser before any of it runs, whether or not the function is
ever called.

That is the whole reason `digest.ts` sits off the barrel at
`@foundry/lib/config/authorization/digest` — an import a renderer cannot make by
accident.

### Why both live here

Config and Authorization share no code and no types — verified in both
directions. Authorization is here because it is the shared _mechanism_ with no
host vocabulary, the same property that makes Config's slices host-agnostic. It
is not configuration, and it does not read Config.

### Entry points

Config lives inside `@foundry/lib` under `src/config/`. `@foundry/lib/config`
resolves to `config.ts`; everything else is a subpath under it.

The map is `"./config/authorization"` plus a `"./config/*"` wildcard over
`src/config/`, so **every file in `src/config/` is importable**, including
`helpers.ts`, which reads as internal.
Types resolve from `dist/`, not `src/`. Rebuild this package before a consumer
typechecks against a changed public API.
