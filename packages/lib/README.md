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

Tests live in `src/test/`, with reusable fixtures in `src/test/helpers/`.
Run `bun run --cwd packages/lib test`, `typecheck`, or `build` from the repo root.
Run lint and formatting checks through the root `lint` and `format` commands.
The build emits declarations; runtime exports resolve to TypeScript source.

## Entry points

Every public subpath is declared explicitly in `package.json` `exports` (no
`./*` wildcards). Pure Web-standard helpers live at top-level subpaths;
Node/Bun-only adapters live under `./node/*`; `@foundry/lib/async-scope` uses
conditional `"node"` / `"bun"` vs. `"default"` exports. Types resolve from
`dist/`, not `src/`. Rebuild this package before a consumer typechecks against
a changed public API.
