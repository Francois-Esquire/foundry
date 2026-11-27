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

- **Domain entry points**: Primary concrete domain **modules** use plural domain nouns: `Workspaces`, `Artifacts`, `Tasks`, `Modules`, `Sessions`, and `Containers` (in `@foundry/sandbox/node`, alongside the portable `Sandbox` interface in `@foundry/sandbox`).
- **Documented exemptions**: Collective, Effect, or DSL nouns keep their natural singular names: `Queue`, `Scheduler`, `Workflow`, `Step`.
- **No `*Manager` or `*System` in `packages/*`**: Both suffixes obscure **depth** and encourage shallow pass-through wrappers. `*Manager` is reserved exclusively for host facades under `apps/*/src/lib/managers/`.
- **`*FileSystem` is allowed**: `*System` is rejected, but `*FileSystem` (`WorkspaceFileSystem`, `ArtifactFileSystem`, `nodeFileSystem`) names a platform concept and is the one permitted suffix.
- **In-memory adapters**: Name in-memory **adapters** `Memory<Name>` (stores `Memory<Domain>Store`, Promise/plain factories `createMemory<Name>`, Effect-returning factories `makeMemory<Name>`); the `InMemory` prefix is not used for exports in `packages/*`. Similarly, SQLite store factories use `createSqlite<Name>` (or `Sqlite<Domain>Store` classes) for Promise/plain APIs and `makeSqlite<Name>` for Effect-returning factories (`queue`, `scheduling`).
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
| `./node/*` | Further OS, filesystem, git, watcher, child-process, and host runtime **adapters**, such as `@foundry/lib/node/file-lock` | Node / Bun |
| `./providers`, `./providers/*` | Opt-in provider-specific **adapters** and outputs (`models`, `usage`, `prompts`, and others) that hosts assemble selectively and `.` never imports | Any; may use Node / Bun |

`./node` and `./node/*` are strictly for OS, filesystem, git, watcher, child-process, and host runtime **adapters** and Node convenience factories. They are not where providers go: a provider-specific **adapter**, whether or not it needs Node, lives at `./providers/*`.

The opt-in runtime subpaths exempt from mandatory Web-standard enforcement are `./node`, `./node/*`, `./providers`, `./providers/*`, and `./testing` helpers other than `./testing/store`. Every other subpath, plus `./testing/store`, must be Web-standard. Opt-in subpaths are recognised by their exact key or prefix, not by a `/node` or `/providers` segment elsewhere in the key.

Source layout mirrors the declared `exports` map:

- Root `.` is served by `src/index.ts`.
- Export key `./a/b` is served by `src/a/b.ts` (or `src/a/b/index.ts` for multi-file directory entries such as `./store` or `./node`), with private implementation files in sibling `src/a/b/`.
- Node-bound public **adapters** sit where their export key puts them (`src/node/`, `src/node.ts`, or `src/providers/`). Private files imported only by `./node*` or `./providers/*` may live beside their importer. What is enforced is that no portable export reaches Node-bound code and that every export mirrors its source path.

Only subpaths that carry real **implementation** are added; packages do not declare empty stubs.

## 4. Stateless core vs. stateful process runtime and `AsyncScope` discipline

Each domain separates its pure, store-backed core **modules** (such as `WorkspaceCatalog`, cadence calculators, and state-transition functions) from long-lived process runtimes (polling loops, timers, file watchers, and process leases). Separating these **seams** lets serverless and transactional hosts (such as Convex) bind the core directly without hosting a persistent daemon, while Node/Bun hosts wire long-lived drivers at the edge.

Runtime-conditional `"node"` / `"bun"` vs. `"default"` exports—specifically `@foundry/lib/async-scope`—are permitted **only** for best-effort diagnostics and defensive guards (such as `Turns` reentrancy errors). They must never carry load-bearing control flow, implicit transaction state, or required business semantics; removing or stubbing `AsyncScope` in a Web-standard runtime must leave domain behavior intact.

## 5. Enforcement

Runtime **seams**, tier rules, store isolation, and naming rules are enforced by the root `tests/` Vitest suite (`bun run test:boundaries`), which runs as part of `bun run validate` alongside Biome/Ultracite, Sherif, TypeScript, and Knip:

- `tests/web-standard.test.ts` audits every portable subpath of every package under `packages/*` (plus `@foundry/core/testing/storage` and `@foundry/models`'s `./providers/gateway` and `./providers/vercel`), so a new package or non-opt-in subpath is audited by default. Portable code must not import Node/Bun built-ins, opt-in subpaths, or unguarded Node/Bun globals (`process`, `Buffer`, `Bun`, `__dirname`, `__filename`, `setImmediate`, `import.meta.dirname`, `import.meta.filename`).
- `tests/package-tiers.test.ts` enforces that every package under `packages/*` is classified in `PACKAGE_TIERS`, dependencies are strictly downward/same-tier and acyclic, no package depends on `@foundry/*` outside `packages/*`, and cross-package isolation rules hold (such as `@foundry/agents` independence from `@foundry/workflows` and `@foundry/sandbox`, `microsandbox` confinement, and `@foundry/modules`'s type-only `@foundry/sandbox` seam).
- `tests/export-layout.test.ts` rejects wildcard exports, enforces that every runtime export target mirrors `./src/<subpath>.ts` or `./src/<subpath>/index.ts` (with the sole permitted divergence for `@foundry/lib`'s `./async-scope` `node`/`bun` conditions) and exists on disk, and rejects exported `*Manager`, `*System` (except `*FileSystem`), and `InMemory*` names outside `test/` and `testing/`.
- `tests/store-isolation.test.ts` enforces that `drizzle-orm` is an optional peer dependency and confined to `store/sqlite.ts` and `store/tables.ts` (and `packages/lib/src/sqlite.ts`), and that `@libsql/*` is never imported in production package source.

Every package migration removes `node:*` imports and unguarded runtime globals from `.` and `./store/memory` without reintroducing them.

## Considered Options

- **Bundler shims or lazy `import("node:*")` inside `.`**: Rejected. Dynamic imports still break static analyzers, edge bundlers, and strict Web runtimes, and hide runtime coupling behind an opaque **interface**.
- **Keeping `./*` wildcard exports for convenience**: Rejected. Wildcards erode **locality** by turning every internal file into an accidental public **seam**.
- **Using `AsyncLocalStorage` for implicit context propagation**: Rejected. It couples domain **implementations** to Node/Bun async hooks and breaks identically in browser and serverless runtimes.

## Consequences

- Every domain's core **module** and `Memory<Domain>Store` **adapter** run unmodified in browsers, edge workers, Convex functions, Vitest, and Node/Bun.
- Node-specific wiring concentrates in `./node` **adapters** and host composition roots (`apps/*`), improving **locality** and keeping domain **interfaces** small and deep.
