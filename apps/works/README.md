# `@foundry/works`

Foundry Works is the desktop shell for building and running Modules. It is an
Electron application: a main process that owns the window, a sandboxed preload
that exposes window chrome operations, and a React renderer with the shell
layout, theme, and routes.

## Layout

| Path               | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `src/main/`        | Electron app lifecycle, window controls, router transport, and vault; `works.ts` composes everything else once |
| `src/main/api/` | `index.ts` exposes the API; context and transport stay here, and `router/index.ts` composes the routes |
| `src/main/execution/` | The Marbles engine adapter, task names, registered workflows, audit stream, retention, and source save evidence |
| `src/main/modules/` | Module library, sandboxes, builds, authoring chat, settings, Access, power, and released runtime |
| `src/main/artifacts/` | Product File Artifacts, editor bindings and resolver, and the `works.artifacts.*` Gateway providers |
| `src/main/gateway/`, `src/main/system/` | Capability provider kit and runtime authority; the shared system theme |
| [`../../modules/`](../../modules/) | Repository Module projects; `documents` provides Markdown editing and workflows |
| `src/preload.ts`   | Exposes `window.worksWindow` through `contextBridge` and forwards the RPC port to main |
| `src/shared/`      | Types, channel names, and the vault registry both processes use       |
| `src/app/`         | Renderer: `index.tsx`, `routes.tsx`, `layout/`, `components/`, `theme/`, `pages/` |
| `src/app/styles/`  | Design tokens, typography, and palette imported by `globals.css`      |
| `test/`            | Vitest suites: `main/` and `shared/` run in Node, `app/` in happy-dom |

Routes are hash-based because the packaged renderer is a `file://` document.
The rail has Home and Artifacts at the top, Modules and Settings at the bottom,
and Module shortcuts in between. `/` opens apps. `/artifacts` is the Artifact grid,
and `/artifacts/:artifactId` opens one through the editor resolver. `/modules` holds
the Catalog and the audit tabs (`?tab=dashboard|calls|workflows|executions|saves`).
`/modules/:moduleId` manages one module through Source, Changes, Releases, and
Access & settings, with a side chat and an on/off switch. `/m/:moduleId` runs the
micro-app with minimal shell chrome. Sidebar module entries open app routes.
`/settings` holds provider and integration credentials.

Source uses `@pierre/trees` for folder navigation and `@pierre/diffs` for code
editing and reviewing the draft against saved source. Drafts survive navigation
in local storage. Saving source does not replace a built release. Releases owns
versioned sandbox builds, progress, logs, and release previews.

## RPC

The renderer calls the main process through [oRPC](https://orpc.dev) over a
`MessagePort`. The renderer creates a `MessageChannel`, posts one end to its
own window, the preload forwards that port to main with
`ipcRenderer.postMessage`, and main upgrades it with the message-port
`RPCHandler`. Router composition lives in `src/main/api/router/index.ts`; the renderer imports
only `AppRouter` from `~/main/api`. Components use the TanStack Query utilities from
`worksApi()` in `src/app/api/client.ts`. Tests call the same router in-process
with `createRouterClient` over an in-memory vault (`test/helpers/fake-api.ts`).
Streaming tests also use real MessageChannels between independent clients.

`vault.watch` emits the current status on connection, then pushes status after
each committed change. Settings uses oRPC's `experimental_liveOptions` to share
one live query across Providers and Integrations. Returning the iterator,
aborting the request, or closing its port releases the vault subscription.
Every new connection starts with a fresh snapshot; the stream is not a durable
change log. oRPC's publisher buffers at most 100 unread status events per watch.

## Vault

Credentials are declared once in `src/shared/vault.ts`: each owner (a model
provider or a tool integration) lists its fields, the tier each is stored in,
and the environment variable consulted when nothing is stored. Secrets are
encrypted with Electron's `safeStorage` and written to `vault.json` in the
user data directory; non-secret settings such as base URLs go to
`settings.json` beside it. The renderer only ever sees presence and source
(`store`, `env`, `default`, `none`), never a value. Main-process consumers read
values with `vault.resolve(owner, key)`.

`store.ts` owns plain JSON persistence, `secure-store.ts` owns the testable
encryption wrapper, and `safe-storage.ts` owns Electron encryption and opening
the app vault. Both the file store and vault serialize mutations and commit
their caches only after persistence succeeds.

## Modules

Works starts Marbles (`@foundry.sh/marbles/engine`) as its required execution engine
before it accepts saves or launches, with state under `<userData>/engine`. Every
documented action is an engine Execution Run: saves, builds, publish, import,
settings, Access, power, Version selection and Program lifetimes run on the
`system` queue, and chat turns and workflows run on per-Module queues. The audit
tabs read those runs.

The library reuses `createModuleProjects` and `importModulePackage` from
`@foundry/modules`. Each Module has `~/.foundry/modules/<moduleId>/` with `source/`
(the editable workspace, including `foundry.module.json`), `artifact/` (the selected
release's files, read-only), and `data/` (the app's private files and database).
Artifact records live in `.library/artifacts.json` under that root, with blob bytes
in `.library/blobs`. The Module Artifact's metadata also holds each Module's one
durable Installation and its Grants. Workspace markers and staging stay in
`.library`. Older `.data/<moduleId>` folders are moved into `data/` once, after a
verified reopen. Product File Artifacts materialize under `~/.foundry/artifacts`.

On first startup using this location, Works copies an existing user-data Module
Artifact store if the new store is absent, preserving the old store. Reading or
building a module captures external workspace edits. Stale saves/builds fail
rather than overwriting newer source. Ignored local files are retained and are
excluded from sandbox build input.

New modules contain a runnable starter. Each Module that is on has one
Microsandbox VM, created on demand, with internet but no host mounts or
credentials. Chat turns and builds borrow it, and it stays up while the Module is
on. Agent tools run as the unprivileged `bun` user in `/workspace`, which each turn
reseeds from the Draft. Builds run as root in a root-only `/builds/<uuid>` scratch
directory. They install, generate, typecheck, and build before publishing an
immutable release. Opening an app starts the latest release; if none exists, Works
builds the first one. Imported output-only releases remain runnable with an
empty-source state. Turning a Module off stops its apps and its sandbox.

The side chat runs an authoring agent on the Module's sandbox copy. Its result is a
proposal: accepting it changes the Draft, and only an explicit save commits it.
Model calls and provider keys stay in main.

`src/main/modules/runtime/` composes the shared Module system, supervisor,
installation files, transport, and container runtime. A released app mounts only
`artifact/` read-only and `data/` read-write. Starting it checks the Manifest's
requirements, the Module settings, and the Installation's Grants first. Works
supplies host Capabilities (`works.system.theme`, `works.editors.binding`,
`works.artifacts.*`, `works.execution.*`). The Access panel approves and revokes
their Grants and the app's network Grant. An approved network Grant becomes the
app's sandbox destination allowlist (HTTPS only), and changing it restarts the open
app. App launches and management previews use the same session implementation.

Views use a random `module-app:` origin with a sandboxed iframe and no preload
bridge. The protocol proxies declared views and assets, and the Program's
`/_module/` routes (GraphQL, theme, Artifact and execution relays), to a validated
loopback program. It blocks private Gateway routes and
redirects, does not forward browser cookies, and applies its own CSP. Relative
assets resolve through the same origin. Stop, navigation, window closure, and
app quit cancel and release the runtime.

The Artifacts grid lists product Artifacts (not Modules) with type labels and
thumbnails. Opening one resolves an editor from installed Modules' `editors[]`
declarations, asks when several match, and remembers the choice per MIME type. The
chosen View receives an opaque, host-owned binding to the file. Saves are fenced by
the entry digest and recorded as engine runs; a stale save returns a conflict
instead of overwriting.

Microsandbox must already be installed. A missing runtime or failed start is
shown in the app or preview. Credentials remain in the Electron vault, outside
Module workspaces.

## Scripts

Run from the repository root:

```bash
bun run --cwd=apps/works dev        # electron-vite dev server with the app open
bun run --cwd=apps/works build      # main, preload, and renderer into dist/
bun run --cwd=apps/works package    # electron-builder unpacked app into dist/release
bun run --cwd=apps/works test
bun run --cwd=apps/works test:electron  # opt-in native transport, restart, and preview tests
bun run --cwd=apps/works test:module-runtime # also starts a real Microsandbox Module
bun run --cwd=apps/works test:module-build # real creation, Pierre edits, builds, and persisted app data
bun run --cwd=apps/works test:real-app     # launches the built app with a temporary home and drives it
bun run --cwd=apps/works typecheck
./node_modules/.bin/biome check apps/works
```

App outputs land under `dist/`: `dist/main`, `dist/preload`, `dist/renderer`, and
`dist/release`. Native test launchers and screenshots go under `.cache/electron`.

The Electron smoke test builds the app and opens its real renderer and preload
against the main-process router with a temporary user-data directory. It checks
status pushed from main, shared subscriptions, navigation, reload, and window
close cleanup. A second test creates a module through the renderer, quits the
process, launches another process with the same isolated profile, and opens the
persisted module and source. A third test renders a local HTTP fixture through
the real protocol and iframe, checks relative assets and scripts, verifies the
preload bridge is absent, and checks Stop and navigation cleanup.
`test:module-runtime` repeats rendering with a real Bun Module in Microsandbox
and adds the network Grant, theme, Markdown editor, and workflow smokes; it
requires the installed runtime and its Bun image (which may be pulled).
`test:real-app` launches the built `dist/main/index.js` with a temporary home and
user-data directory, then drives it over the DevTools protocol. It imports the
fixture, approves Access, creates and saves a Markdown file in the fixture editor,
checks the audit tabs, and quits.
These tests need a desktop session and remain separate
from `test`. The runner removes inherited Electron Node-mode and dev-server
flags. Its CommonJS launchers point `import.meta.dirname` at the built main
directory so the window loads the built renderer and preload.

## Window chrome

The window is frameless. The title bar draws its own controls and talks to the
main process over four IPC channels: minimize, close, set fullscreen, and read
the current mode. The green control sets fullscreen from the observed mode
rather than toggling, so an OS shortcut cannot leave it out of step. Outside
Electron the bridge is absent and the controls are inert.

## Theme

Main owns the chosen mode (`auto`, `light` or `dark`), stored in `<userData>/theme.json`
and applied to Electron's `nativeTheme`. The renderer caches it under `theme-mode`
in `localStorage` to paint before React mounts. On first run it hands that value to
main, then follows main's stream. `auto` follows the desktop appearance. Module apps
with an approved `works.system.theme` Grant receive the mode and effective
appearance, then each change.

Public Sans supplies interface text and headings, and IBM Plex Mono supplies
source and monospace text. Font files are
self-hosted; immutable upstream provenance and exact Open Font License notices
live beside the assets in `src/app/fonts/` and are included in packaged apps.
