# `@foundry/works`

Foundry Works is the desktop shell for building and running Modules. It is an
Electron application: a main process that owns the window, a sandboxed preload
that exposes window chrome operations, and a React renderer with the shell
layout, theme, and routes.

## Layout

| Path               | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `src/main/`        | Electron app lifecycle, window controls, router transport, vault, and module library |
| `src/main/router/` | `root.ts` composes the typed router; domain procedures live in `vault.ts` and `modules.ts` |
| `src/main/modules/` | Artifact-backed module persistence and library operations |
| `src/preload.ts`   | Exposes `window.worksWindow` through `contextBridge` and forwards the RPC port to main |
| `src/shared/`      | Types, channel names, and the vault registry both processes use       |
| `src/app/`         | Renderer: `index.tsx`, `routes.tsx`, `layout/`, `components/`, `theme/`, `pages/` |
| `src/app/styles/`  | Design tokens, typography, and palette imported by `globals.css`      |
| `test/`            | Vitest suites: `main/` and `shared/` run in Node, `app/` in happy-dom |

Routes are hash-based because the packaged renderer is a `file://` document.
`/` lists modules and supports creation and package import. `/settings` holds
provider and integration credentials. `/modules/:moduleId` opens a named Module
workspace with its authored files, a read-only source overview, and released
Module views. Source editing, building, and durable installations remain later
milestones.

## RPC

The renderer calls the main process through [oRPC](https://orpc.dev) over a
`MessagePort`. The renderer creates a `MessageChannel`, posts one end to its
own window, the preload forwards that port to main with
`ipcRenderer.postMessage`, and main upgrades it with the message-port
`RPCHandler`. Router composition lives in `src/main/router/root.ts`; the renderer imports
only the router's type. Components use the TanStack Query utilities from
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

The library reuses `createModuleProjects` and `importModulePackage` from
`@foundry/modules`. Module identity, retained manifests, authored Content, and
blobs share the existing Artifact transaction, persisted by `JsonArtifactStore`
in `modules/artifacts.json` under user data. The library adapter supports
library operations; preview composition separately reuses the shared Module
system, supervisor, immutable checkouts, installation files, and container runtime.

New modules start with a manifest and README. Imported output-only releases
remain visible with an explicit empty-source state. The library refuses corrupt
storage and invalid or duplicate module registrations. Sidebar navigation
reflects the saved library.

A built release with declared views can be previewed from its workspace. The
preview creates a temporary Installation and starts its Bun program inside
Microsandbox. No host capability providers or grants are supplied. Required
capabilities therefore fail through the shared Gateway. Preview files are
removed after stop; preview Installations are not restored on restart. Verified
program checkouts remain cached under `modules/preview/checkouts`.

`modules.preview` is a lifetime stream: Start subscribes, and Stop, changing
release, navigation, reload, port closure, or app quit cancels and releases the
runtime. Views use a random `module-preview:` origin with a sandboxed iframe,
without the preload bridge. The protocol proxies only declared view routes,
assets, and the Module GraphQL endpoint to a validated loopback program. It
blocks private Gateway routes and redirects, does not forward browser cookies,
and applies its own CSP. Relative assets resolve through the same origin.

Microsandbox must already be installed; Works does not install it during app
startup or preview. A missing runtime or failed start is shown in Preview.
Newly created source-only Modules have no built release yet.

## Scripts

Run from the repository root:

```bash
bun run --cwd=apps/works dev        # electron-vite dev server with the app open
bun run --cwd=apps/works build      # main, preload, and renderer into dist/
bun run --cwd=apps/works package    # electron-builder unpacked app into dist/release
bun run --cwd=apps/works test
bun run --cwd=apps/works test:electron  # opt-in native transport, restart, and preview tests
bun run --cwd=apps/works test:module-runtime # also starts a real Microsandbox Module
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
and requires the installed runtime and its Bun image (which may be pulled).
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

The chosen mode is stored under `theme-mode` in `localStorage` and applied to
the document before React mounts. `auto` follows the desktop appearance.

Public Sans supplies interface text and headings, and IBM Plex Mono supplies
source and monospace text. Font files are
self-hosted; immutable upstream provenance and exact Open Font License notices
live beside the assets in `src/app/fonts/` and are included in packaged apps.
