# @foundry/models

An ordered set of provider instances — hosted gateways, Vercel, on-device
weights, and the CLI harnesses — and one catalog-checked way to choose among
them. Resolving a selection returns a route; opening it returns an AI SDK model.

Also owns the catalog: what each model costs, how large its context is, what it
can do.

## Quick start

```typescript
import { ModelManager } from "@foundry/models";
import { vercelProvider } from "@foundry/models/vercel";

const models = new ModelManager({
  providers: [vercelProvider({ config: { apiKey } })],
});

const route = models.resolve("text", "vercel/openai/gpt-5.6-luna");
const model = route.open(); // AgentModel
// … generateText({ model, … })
route.release();
```

`resolve(kind, selection?)` checks the catalogs and holds nothing. A selection
is a model id, `provider/model`, or `{ provider?, model? }`: a model alone goes
to the first provider in order that lists it; a provider alone uses its default
for the kind; nothing picks the first available provider serving the kind. An
id no catalog lists is refused rather than passed through.

`open()` leases the instance until `release()` (or `using`), so a session keeps
it after it leaves the set. For `"text"` it returns an `AgentModel` — the
`LanguageModelV4` to hand to `generateText`, `streamText`, or an agent,
carrying its `route` and `limits`. Other kinds return the AI SDK model for the
kind: `"embedding"`, `"image"`, `"speech"`, `"transcription"`, `"video"`, and
`"music"`, `"sound"`, `"segmentation"` as a `MediaModel`.

## A provider is a record

```typescript
interface Provider {
  id: string; // the instance id; unique within a set
  offline: boolean; // can serve without network
  available: boolean; // credentialed / installed / switched on
  models: readonly ProviderModelDefinition[]; // the catalog, fixed for life
  defaults?: Partial<Record<ModelKind, string>>; // catalog id per kind
  turnLimit?: "native" | "steps" | "unsupported";

  languageModel(modelId, options?): LanguageModelV4;
  embeddingModel?(modelId): EmbeddingModelV4;
  imageModel?(modelId): ImageModelV4;
  transcriptionModel?(modelId): TranscriptionModelV4;
  speechModel?(modelId): SpeechModelV4;
  videoModel?(modelId): Experimental_VideoModelV4;
  mediaModel?(modelId): MediaModel;
  grant?(modelId, operation): Promise<LiveAccess>;

  setOffline?(offline: boolean): void | Promise<void>;
  dispose?(): Promise<void>;
}
```

The model methods are the AI SDK's own `ProviderV4` shape and take the **wire**
id. Resolving a catalog id to a wire id is the manager's job. Adding a provider
is writing one of these:

```typescript
import { createVertex } from "@ai-sdk/google-vertex";

import { fromSdk } from "@foundry/models";

const vertex = fromSdk(
  {
    id: "vertex",
    offline: false,
    available: Boolean(project),
    models: [{ id: "gemini-2.5-pro", modelId: "gemini-2.5-pro", kind: "text" }],
  },
  createVertex({ project }),
);
models.setProviders([...models.providers, vertex]);
```

Each built-in factory is its own subpath, so a host bundles only what it
configures: `vercelProvider` (`@foundry/models/vercel`), `gatewayProvider`
(`/gateway`), `falProvider` (`/fal`), `replicateProvider` (`/replicate`),
`claudeCodeProvider` (`/claude-code`), `codexProvider` (`/codex`), and
`piProvider` (`/pi`). Each takes `id` and `models`, so one factory can build
several instances; all but FAL and Replicate also take `defaults`. The root
entry exports no provider. `gatewayProvider` has no models of its own and
requires `models`. `gatewayModels(config)` reads them from the server's
`GET <baseURL>/models`, each id as a text model with nothing else known.

| Subpath | What it holds |
| --- | --- |
| `/airplane` | `airplaneMode`: the offline-only policy for one manager |
| `/local` | `LocalProvider` and `configureCache`: on-device transformers-js |
| `/local/remote` | `forkLocalWorker`: the worker process and its IPC transport |
| `/local/remote/provider` | `RemoteLocalProvider`: the local surface over that transport |
| `/live`, `/live/node` | Live interactions, browser and Node |
| `/catalog/*` | Catalog adapters, and models.dev read at run time |
| `/embeddings/*` | Chunking, embedding, and ranking |
| `/model-option`, `/cost` | Pure leaves; see below |

**models.dev at run time.** `holdModelsDev()` (`/catalog/models-dev-source`)
starts fetching `https://models.dev/catalog.json`, or joins the fetch already
running, and returns a hold whose `loaded` settles with that fetch and
never rejects. Once loaded, the catalog is kept for the life of the process.
A fetch that fails is tried again while any hold remains: after 30 s, then
twice as long each time, up to 10 minutes. A new hold tries at once. Release
the hold when the host stops. When the last hold is released, a running
fetch is aborted and a waiting retry is cancelled, so neither keeps a
finished process open. An aborted fetch keeps nothing. Nothing waits for
models.dev: until it has loaded, and when it fails, a price that needs it is
absent. `loadedModelsDev()` returns what has loaded, without fetching.
`FOUNDRY_MODELS_DEV_URL` names another source; an empty value loads nothing. `enrichFromModelsDev(rows, catalog)` (`/catalog/models-dev`)
fills a row's absent facts from it and never overrides what the row states.

**Two ids per row, on purpose.** `id` is how callers and the picker name a
model; `modelId` is what goes on the wire. They coincide for cloud rows and
differ for on-device rows, whose short ids (`text`, `embed`) hosts persist.
Live access is the exception: `grant(id, operation)` takes the catalog id and
returns a token or a proxy, never a key.

## The manager

```typescript
new ModelManager({ providers? });
manager.providers; // the set, in preference order, as guarded views
manager.setProviders(providers); // replace the set; leavers are disposed once released
manager.resolve(kind, selection?); // Resolution: check, hold, open, release
manager.restrict(policy); // install a ProviderPolicy; returns the remover
await manager.dispose(); // release every instance, leased ones included
manager.events; // providers-changed, policies-changed, provider-retired, …
```

Order is preference. Every view the manager hands out, and every model or
live access opened through one, consults the installed policies on each call;
a call in flight on an instance a new policy refuses is aborted.

**Airplane Mode** is one such policy. `airplaneMode(manager).set(true)` admits
only providers with `offline: true`, and tells every instance the manager
still holds, leased ones that left the set included, to `setOffline(true)`.
It is off when created and never persisted.

## `@foundry/models/model-option` · `/cost`

Pure leaves a renderer can import without the Node-only runtime:
`toModelOption(row)` flattens a catalog row for a picker; `costFromUsage(costs,
usage)` prices a turn with cache and tiered rates. Use these subpaths for browser
code; the root entry also imports registry and observability code.

`claudeCodeCallCost(providerMetadata)` returns what Claude Code reported a
call cost (its `total_cost_usd`), only for a call that resumed no session.
That figure is a running total for the CLI session, so only such a call has
a figure of its own. The Claude Code provider marks that call in
`providerMetadata.foundry.claudeCodeFresh`. It marks a call only when the
model's settings, default settings included, name no `resume`, `continue`,
`sessionId` or `extraArgs`, and no earlier call ran on the same model instance, since
the instance resumes the session its first call opened. The CLI computes
the figure from its own price table on any login, so it is an estimate.

## Observability · errors

`beginTurnObservation()` opens one wide event per turn; `observeAgentTurn` is
the same thing in the shape an agent surface takes (`observe`), so the harness
wraps the model and settles the event itself. `configureModelObservability`
wires the drain; the manager keeps its cost map current from the catalogs.
Errors are a defined catalog (`modelErrors`), so callers branch on the code.

## Notes

- Types resolve from `dist/`. Build this package before a consumer typechecks
  against a changed public API.
- `/local` loads transformers-js; the root entry never does.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.

One `vitest.config.ts` defines the `unit`, `integration`, and `pi` projects.
The default test suite excludes credentialed vendor tests, the
network-dependent tree-sitter grammar test (`*.integration.test.ts`), and the
Pi runtime test. Run `bun run test:integration` explicitly with the relevant
provider credentials and media fixtures to exercise them. Vendor tests can make
paid API calls. The grammar test needs network access or a cached grammar and
fails, rather than skips, when neither is available.
The model catalog is application data, not a dependency version catalog.

## Pi harness

`@foundry/models/pi` exports `piProvider` and `createPiDriver`. Model calls use
[`ai-sdk-provider-pi`](https://github.com/ben-vargas/ai-sdk-provider-pi) 0.1.0,
with AI SDK's `wrapLanguageModel` adapting its V3 model to the V4 contract.
The provider embeds Pi 0.52.12. Sandbox sessions use the separately pinned
Pi 1.3.0 CLI over RPC. Models remains private at 0.1.0 when Marbles releases.

```ts
import { ModelManager } from "@foundry/models";
import { piProvider } from "@foundry/models/pi";

const provider = piProvider({
  config: { available: true, defaultSettings: { tools: "readOnly" } },
});
const models = new ModelManager({ providers: [provider] });
const route = models.resolve("text", "pi/anthropic/claude-sonnet-4-5");
const model = route.open({ workingDirectory: "/path/to/project" });
```

Model calls use the community provider's Pi sessions, authentication, tool
execution, streaming, images, and usage reporting. `defaultSettings` accepts
its `PiSettings`, including `agentDir`, `thinkingLevel`, and session options.
The default tool set is `readOnly` and logging is disabled. The default model
is included in the provider's pinned catalog; custom models can be configured
in Pi's `models.json`. Structured JSON output uses prompt guidance rather than
provider-enforced schemas. Call `dispose()` when the host stops using a provider.

The native driver accepts an injected process launcher and an extension writer,
so a sandbox host controls where every process and tool runs. It supports
native session resume, streamed text and reasoning, usage, steering,
interruption, host questions through `ask_user`, and bounded tool loops. It
loads only its generated extension and disables discovered extensions, MCP,
skills, templates, and context files. Tool observations retain input field
names rather than arguments or results.

`PI_BIN=/path/to/pi bun run test:pi` runs the actual Pi executable against a
local fixture model. It exercises tool execution, session persistence, and the
AI SDK provider through `generateText` and `streamText` without vendor
credentials. The default unit suite tests protocol failures and permission
handling without requiring Pi to be installed.
