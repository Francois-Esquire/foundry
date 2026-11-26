# Authorization

The authorization context decides whether a principal may perform an action on a target, tracks delegated authority across an approval DAG, enforces guardrails, and issues revocable permits. It knows nothing about agents, modules, workflows, or how protected work executes.

## Language

### Authority

**Principal**:
An acting identity identified by kind and id, with optional version and attributes.
_Avoid_: actor, subject, user

**Scope**:
An action, a target matcher, optional algebraic constraint bounds, and an optional opaque constraints digest describing what an authority covers.
_Avoid_: permission, rule, capability spec

**Constraint Bound**:
One closed algebraic predicate (`eq`, `in`, `range`, `prefix`, `domainSuffix`, or `commandPrefix`) over a request attribute, supporting decidable narrowing.
_Avoid_: condition, filter, expression

**Grant**:
A persisted authority node in the authority DAG linking parent grants, a holder matcher, a scope, delegation rights, approval quorum state, and optional use or lifetime ceilings.
_Avoid_: policy, certificate, token

**Restriction**:
A persisted guardrail (`deny` or `require-direct-grant`) evaluated conservatively so missing, malformed, or wrongly typed request attributes never bypass it. `commandPrefix` matching is a best-effort word-prefix check rather than a full shell parser.
_Avoid_: deny rule, blocklist, veto

### Execution

**Access Request**:
One concrete authorization query naming the acting principal, action, target, attributes, and optional session or invocation context.
_Avoid_: check input, auth call

**Decision**:
The inert read-only answer to an access request: `allow` with a validated grant path, `ask` when no eligible grant covers it, or `deny` when blocked by a restriction.
_Avoid_: verdict, result

**Invocation Claim**:
A persisted consumption record keyed by invocation id that prevents one-shot and at-most-once grants from being replayed across retries or processes.
_Avoid_: receipt, lock, nonce

**Permit**:
An unforgeable execution handle returned by authorization, carrying a receipt and an in-process abort signal wired to live grant revocations and newly added deny restrictions (including committed host transactions bound via `within`). Expiry is enforced at evaluation time rather than by background timers.
_Avoid_: lease, ticket, handle

**Grant Path**:
The ordered chain of grant ids from the matched grant through every active ancestor required to validate it.
_Avoid_: lineage, chain, ancestry
