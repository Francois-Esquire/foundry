---
status: accepted
date: 2026-11-26
---

# Unified Authorization Control Plane

Foundry needs a single durable authorization **module** that serves live and deferred agent tool calls, module capability preflight and sub-module delegation, workflow approval gates, delegated spend and quorum workflows, subagent attenuation, and dynamic guardrails that abort in-flight work. Previously, authorization concerns were split across ad-hoc policy helpers in `@foundry/lib/authorization`, module installation grants, and agent session checks.

## Decision

We introduce `@foundry/authorization` in the **Domains** tier, modeled around **Structure 3: Authority Tree + Scope Lattice + Restrictions**:

1. **Decidable `Scope` lattice (`src/scope.ts`)**:
   - Every `Scope` pairs an exact `action`, a `ScopeMatcher` (`any`, `exact`, `prefix`, `in`), a closed algebraic map of `ConstraintBound` predicates (`eq`, `in`, `range`, `prefix`, `domainSuffix`, `commandPrefix`), and an optional opaque `constraintsDigest`.
   - `covers(scope, request, mode)` evaluates fail-closed in `"allow"` mode (missing, malformed, or wrongly typed attributes return `false`; shell metacharacters and abnormal spacing are rejected on `commandPrefix`) and conservatively in `"restrictive"` mode (missing, malformed, or wrongly typed attributes return `true` so they cannot bypass a guardrail). `commandPrefix` is a deliberate best-effort word-prefix check rather than a shell parser.
   - `narrows(child, parent, options)` defines a decidable partial order (`child ⊑ parent`) used for delegation ceilings, approval tightening, and fail-closed digest comparisons.

2. **Unified `Grant` DAG and `Restriction` guardrails (`src/schema.ts`)**:
   - Every authority—root host grants, pending approval requests, multi-approver quorums, session grants, one-shot grants, and delegated sub-grants—is a `Grant` node linked by `parentIds` (`state`: `pending`, `active`, `denied`, `revoked`, `exhausted`; expiry via `expiresAt` is evaluated dynamically on read and authorize).
   - `Restriction` records (`deny` and `require-direct-grant`) apply globally or under an ancestor `appliesUnder` grant.
   - `InvocationClaim` persists consumption by `invocationId` inside the store transaction and atomically decrements every finite-use grant in the validated `grantPath`, preventing double-claims and delegated use multiplication across retries or concurrent processes.

3. **Unforgeable revocable `Permit` and `Authorization` control plane (`src/permit.ts`, `src/authorization.ts`)**:
   - `Permit` requires an unexported private symbol at construction and exposes `receipt` (`grantPath` through all validated ancestors), `signal` (`AbortSignal`), and idempotent `release()`.
   - `Authorization` uses subscribe-then-check live wiring so in-process post-commit grant revocations (including revoking any ancestor in `grantPath`) and newly added matching `deny` restrictions immediately abort active permits, isolated from throwing `watch()` observers. Cross-process live abort and timer-driven expiry abort are intentionally out of scope.
   - `Authorization.within(store, effects)` binds a host-owned transaction view (`durability: "host"`) to the parent `Authorization` event hub via `@foundry/core/storage` `CommitEffects`, so rolled-back host transactions emit nothing while committed host revocations abort existing live permits.

4. **Naming exemption**:
   - Alongside the collective/Effect/DSL singular exemptions in ADR-0001 (`Queue`, `Scheduler`, `Workflow`, `Step`), `Authorization` is documented as a collective domain noun for the primary entry point of `@foundry/authorization`.

5. **Runtime seams**:
   - `.`, `./store`, `./store/memory`, and `./testing/store` are 100% Web-standard (zero `node:*` imports, zero unguarded Node/Bun globals, zero import-time I/O).
   - `./store/sqlite` and `./store/tables` provide the Drizzle/SQLite persistence adapter with `Turns` reentrancy protection and `SQLiteTransaction` host-durability detection.

## Deferred Phase 2 Migrations

Phase 1 introduces `@foundry/authorization` and its full conformance, security, and cross-process SQLite exclusion test suites without altering existing consumers. Phase 2 will migrate:

- `@foundry/agents` session/tool authorization and subagent attenuation onto `@foundry/authorization`.
- `@foundry/modules` installation grants and capability gateway checks onto `@foundry/authorization`.
- `@foundry/workflows` approval gates and `@foundry/models` / host facades in `apps/marbles` and `apps/works`.
- Deprecation and removal of the legacy `@foundry/lib/authorization` prototype once all callers migrate.

## Consequences

- One authority model and store contract covers interactive approvals, multi-approver quorums, delegated attenuation, one-shot execution, and live revocation across browsers, serverless runtimes, and local SQLite hosts.
- Cross-tier dependency rules from ADR-0001 remain acyclic (`@foundry/authorization` depends only on `@foundry/core` and `@foundry/lib`).
