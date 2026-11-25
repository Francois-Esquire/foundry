---
status: accepted
date: 2026-11-24
---

# Package Architecture and Runtime Seams

Foundry packages are consumed by Node/Bun CLI hosts (`marbles`), Electron (`works`), browsers, and serverless transactional runtimes (such as Convex). To keep every domain **module** portable, testable, and deep across these environments, we enforce a three-tier package taxonomy, a strict naming standard, Web-standard root **interfaces**, explicit subpath **seams**, and automated import-graph verification.

## 1. Three-tier package taxonomy

Every package under `packages/*` belongs to exactly one tier:

- **Primitives**: `core`, `lib`
- **Tools / Engines**: `prompts`, `usage`, `models`
- **Domains**: `workspaces`, `artifacts`, `tasks`, `modules`, `agents`, `sandbox`, `workflows`, `queue`, `scheduling`

Dependency direction is strictly acyclic across tiers (`Primitives` ← `Tools / Engines` ← `Domains`). **Tools / Engines** must never depend on **Domains**. Whenever a tool and a domain share a contract—such as the reference protocol shared by `prompts`, `agents`, and `models`—that contract moves down into `@foundry/core` (for example `@foundry/core/agents`) so each **module** preserves **locality** and avoids upward coupling.

## 2. Naming standard

- **Domain entry points**: Primary concrete domain **modules** use plural domain nouns: `Workspaces`, `Artifacts`, `Tasks`, `Modules`, `Sessions`, `Sandboxes`.
- **Documented exemptions**: Collective, Effect, or DSL nouns keep their natural singular names: `Queue`, `Scheduler`, `Workflow`, `Step`.
- **No `*Manager` or `*System` in `packages/*`**: Both suffixes obscure **depth** and encourage shallow pass-through wrappers. `*Manager` is reserved exclusively for host facades under `apps/*/src/lib/managers/`.
- **In-memory store adapters**: Name in-memory **adapters** `Memory<Domain>Store` (never `InMemory*Store`).
- **Artifacts port**: The storage/substrate port **interface** for `@foundry/artifacts` is `ArtifactSubstrate` so `Artifacts` unambiguously names the concrete domain **module**.

## 3. Web-standard `.` root and canonical Domain subpath anatomy

Every package declares explicit `exports` in `package.json`. Wildcard exports (`./*`) are forbidden: they bypass the package **seam** and let callers couple directly to internal **implementation** files.

The `.` root **interface** of every package must be 100% Web-standard JavaScript/TypeScript:

- Zero direct or transitive `node:*` imports.
- Zero unguarded Node or Bun globals (`process`, `Buffer`, `Bun`, `__dirname`, `__filename`, `setImmediate`).
- Zero import-time I/O.
- No Node-dependent default **adapters**; callers supply environment-specific **adapters** at the **seam**.

Domain packages follow a canonical subpath layout so callers gain consistent **leverage** across the repository:

| Subpath | Role | Runtime constraint |
| --- | --- | --- |
| `.` | Core domain **module**, types, and pure operations | 100% Web-standard |
| `./store` | Store port **interfaces** | 100% Web-standard |
| `./store/memory` | `Memory<Domain>Store` **adapter** | 100% Web-standard |
| `./store/sqlite` | SQLite/Drizzle store **adapter** | SQLite / Drizzle |
| `./store/tables` | Drizzle schema tables | Drizzle |
| `./testing/store` | Shared store conformance suite | Portable test helper |
| `./node` | OS, filesystem, git, watcher, and child-process **adapters** plus Node convenience factories | Node / Bun |

Only subpaths that carry real **implementation** are added; packages do not declare empty stubs.

## 4. Stateless core vs. stateful process runtime and `AsyncScope` discipline

Each domain separates its pure, store-backed core **modules** (such as `WorkspaceCatalog`, cadence calculators, and state-transition functions) from long-lived process runtimes (polling loops, timers, file watchers, and process leases). Separating these **seams** lets serverless and transactional hosts (such as Convex) bind the core directly without hosting a persistent daemon, while Node/Bun hosts wire long-lived drivers at the edge.

Runtime-conditional `"node"` / `"bun"` vs. `"default"` exports—specifically `@foundry/lib/async-scope`—are permitted **only** for best-effort diagnostics and defensive guards (such as `Turns` reentrancy errors). They must never carry load-bearing control flow, implicit transaction state, or required business semantics; removing or stubbing `AsyncScope` in a Web-standard runtime must leave domain behavior intact.

## 5. Enforcement

Runtime **seams** and tier rules are enforced through package-level Vitest suites (such as browser/runtime-safety tests and manifest checks) alongside `bun run validate` (Biome/Ultracite, Sherif, TypeScript, and Knip). Every package migration removes `node:*` imports and unguarded runtime globals from `.` and `./store/memory` without reintroducing them.

## Considered Options

- **Bundler shims or lazy `import("node:*")` inside `.`**: Rejected. Dynamic imports still break static analyzers, edge bundlers, and strict Web runtimes, and hide runtime coupling behind an opaque **interface**.
- **Keeping `./*` wildcard exports for convenience**: Rejected. Wildcards erode **locality** by turning every internal file into an accidental public **seam**.
- **Using `AsyncLocalStorage` for implicit context propagation**: Rejected. It couples domain **implementations** to Node/Bun async hooks and breaks identically in browser and serverless runtimes.

## Consequences

- Every domain's core **module** and `Memory<Domain>Store` **adapter** run unmodified in browsers, edge workers, Convex functions, Vitest, and Node/Bun.
- Node-specific wiring concentrates in `./node` **adapters** and host composition roots (`apps/*`), improving **locality** and keeping domain **interfaces** small and deep.
- Existing packages that still violate these **seams** are tracked explicitly in the shrinking allowlist and migrated incrementally without regressing clean packages.
