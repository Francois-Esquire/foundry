# @foundry/models

One registry over every model the app can reach — hosted gateways, Vercel,
on-device weights, and the CLI harnesses — behind a single
`manager.model(id, provider)` call that returns an AI SDK model.

Also owns the catalog: what each model costs, how large its context is, what it
can do.

## Quick start

```typescript
import { ModelManager } from "@foundry/models";
import { vercelProvider } from "@foundry/models/vercel";

const models = new ModelManager({
  providers: [vercelProvider({ config: { apiKey } })],
});
await models.init(); // live catalog discovery; optional

const model = models.model("openai/gpt-5-mini", "vercel");
```

`model()` returns an `AgentModel` — the `LanguageModelV4` to hand straight to
`generateText`, `streamText`, or an agent, carrying its `route` (catalog id,
provider, harness) and `limits` (context window) so an agent needs nothing
else. Every argument is optional: `models.model()` resolves the default
provider's default text model.

Other kinds work the same way:

```typescript
models.embedding(id?, provider?); // EmbeddingModelV4
models.image(id?, provider?); // ImageModelV4
models.speech(id?, provider?); // SpeechModelV4
models.transcription(id?, provider?); // TranscriptionModelV4
```

## A provider is a record

```typescript
interface Provider {
  id: string;
  harness: string; // who runs the turn: "studio" | "claude-code" | "codex"
  offline: boolean; // can serve without network
  available: boolean; // credentialed / installed / switched on
  models: ProviderModelDefinition[]; // the catalog; discovery replaces it
  defaults?: Partial<Record<ModelKind, string>>; // catalog id per kind

  languageModel(modelId, options?): LanguageModelV4;
  embeddingModel?(modelId): EmbeddingModelV4;
  imageModel?(modelId): ImageModelV4;
  transcriptionModel?(modelId): TranscriptionModelV4;
  speechModel?(modelId): SpeechModelV4;

  configure?(patch): void;
  discover?(): Promise<ProviderModelDefinition[]>;
  setOffline?(offline: boolean): void;
  dispose?(): Promise<void>;
}
```

The model methods are the AI SDK's own `ProviderV4` shape and take the **wire**
id. Resolving a catalog id to a wire id is the manager's job. Adding a provider
is writing one of these:

```typescript
import { createVertex } from "@ai-sdk/google-vertex";

import { fromSdk } from "@foundry/models";

models.register(
  fromSdk(
    {
      id: "vertex",
      harness: "studio",
      offline: false,
      available: Boolean(project),
      models: [
        { id: "gemini-2.5-pro", modelId: "gemini-2.5-pro", kind: "text" },
      ],
    },
    createVertex({ project }),
  ),
);
```

Built-in factories, each on its own subpath so a host bundles only what it
registers: `gatewayProvider` (`@foundry/models/gateway`, any OpenAI-compatible
host), `vercelProvider` (`/vercel`), `falProvider` (`/fal`),
`replicateProvider` (`/replicate`), `claudeCodeProvider` (`/claude-code`),
`codexProvider` (`/codex`). The root entry exports the contract and the
manager and no provider. On-device weights are the `LocalProvider` class
behind `@foundry/models/local` (see below).

The credentialed factories also export a **binding** (`vercelBinding`,
`gatewayBinding`, `falBinding`, `replicateBinding`): how that provider follows
the shared credential record. A host registers the bindings it ships and
`manager.configure(credentials)` walks them; the manager itself names no
provider.

**Two ids per row, on purpose.** `id` is how callers and the picker name a
model; `modelId` is what goes on the wire. They coincide for cloud rows and
differ for on-device rows, whose short ids (`text`, `embed`) hosts persist. An
id the catalog does not know passes through as the wire id on the kind
accessors; `select` and `media` refuse it.

**Three axes, kept apart.** `harness` is who runs the turn, `provider` is who
serves the model, `vendor` is who made it. The gateway serves a `gpt-5.5` and so
does the Codex CLI; routing keys on the pair `(harness, id)`.

## The manager

```typescript
new ModelManager({ providers?, bindings?, defaults?, settings? });
manager.bind(binding); // let a provider follow the credential record
manager.bootstrap({ credentials? }); // applies credentials; embeddings → local if registered
manager.register(p) / unregister(id) / has(id) / get(id) / list();
manager.local; // the on-device provider, or null

manager.setDefault(kind, { provider, modelId? }) / getDefault(kind);
manager.defaultProviderFor(kind); // configured default → first usable online
manager.resolveTextExecutor(modelId?, providerId?, harnessId?); // durable route
manager.textLimits(modelId?, providerId?) / embeddingDimensions(...);

await manager.init(); // runs every discover(); returns what changed
await manager.dispose(); // stops child processes
manager.configure(credentials); // each binding registers, re-keys, or removes its provider
manager.setOfflineMode(enabled) / manager.offlineMode;
```

Asking by Operation rather than by kind reads Capability facts, never `kind`:

```typescript
manager.select(operation, { provider?, model?, mode? }); // { provider, model, fact }
manager.offers(operation?); // every registered row bearing the fact, with `available`
manager.video(id?, provider?); // Experimental_VideoModelV4
manager.media(id, provider); // segmentation, music, sound effect — both ids explicit
```

A row without a fact for the Operation is refused, not substituted; `fact.outputs[0]`
is the MIME the caller will get. Live access for a `mode: "live"` fact is the
provider's own `grant(id, operation)`, which returns a token or a proxy and
never a key.

Routing order for any kind: the explicit provider → that kind's default → the
first available online provider serving the kind. Per-kind defaults are what let
embeddings run locally while text goes to a gateway; `settings.defaults` feeds
the same map reactively.

**Airplane Mode** resolves to `manager.local` and nowhere else. A provider's
`offline: true` is catalog metadata; only the provider registered as `local`
that implements the full on-device surface counts.

**Discovery replaces, never merges.** `init()` runs each provider's `discover()`
and, when it returns rows, swaps the catalog for them. A failure keeps the floor
serving. The returned map lets a host persist the fresh catalog; assign
`provider.models = stored` before `init()` to hydrate it back on an offline boot.

## `@foundry/models/local`

The on-device runtime is its own entry point. The root barrel exports only the
`LocalProviderSurface` type and `isLocalProvider`, so importing the registry
never loads transformers-js; a host that wants weights on this machine imports
the subpath and registers the provider as `local` itself:

```typescript
import { configureCache, LocalProvider } from "@foundry/models/local";

configureCache(cacheDir);
models.register(new LocalProvider());
models.bootstrap(); // now routes embeddings on-device
```

`LocalProvider` serves text, embedding, and transcription through
transformers-js and manages weights by catalog id:

```typescript
local.status() / preload() / download(id) / progress(id);
local.isDownloaded(id) / downloadedModels();
local.transcribe(audio, options?, id?); // with segments
local.events; // "download-progress" | "model-loaded"
```

Model instances are cached per wire id across every instance in the process:
transformers-js holds the ONNX session in each one, so a second build would load
the weights twice.

`RemoteLocalProvider` is the same surface served by a forked worker
(`forkLocalWorker` + the `remote/worker-entry` executable), for hosts whose own
process should not hold large text weights. A host can keep embedding and
transcription in-process and run text generation in the worker.

## `@foundry/models/model-option` · `/cost`

Pure leaves a renderer can import without the Node-only runtime:
`toModelOption(row)` flattens a catalog row for a picker; `costFromUsage(costs,
usage)` prices a turn with cache and tiered rates. Use these subpaths for browser
code; the root entry also imports registry and observability code.

## `@foundry/models/catalog`

`fromGateway`, `fromVercelRest`, `fromCodexListing` build rows from upstream
shapes; `enrichFromModelsDev` / `enrichFromSnapshot` fill limits, capabilities,
and cache rates from the bundled models.dev snapshot. Enrichment never overwrites
a provider's stated price and matches ids exactly — no fuzzy matching, no alias
pinning. The models.dev snapshot is bundled, not fetched; refresh with
`scripts/sync-models-dev.ts`. Gateway deployment snapshots are not bundled.
Supply gateway rows through the provider's `models` option; use `fromGateway`
to normalize LiteLLM responses.

## Observability · errors

`beginTurnObservation()` opens one wide event per turn; `observeAgentTurn` is
the same thing in the shape an agent surface takes (`observe`), so the harness
wraps the model and settles the event itself. `configureModelObservability`
wires the drain; the manager keeps its cost map current from the catalogs.
Errors are a defined catalog (`modelErrors`), so callers branch on the code.

## Notes

- Types resolve from `dist/`. Build this package before a consumer typechecks
  against a changed public API.
- `embeddings/` (chunking) lives here beside the models that consume it; see
  `@foundry/models/embeddings`.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.

The default test suite excludes credentialed vendor tests. Run
`bun run test:integration` explicitly with the relevant provider credentials
and media fixtures to exercise them. These tests can make paid API calls.
The model catalog is application data, not a dependency version catalog.
