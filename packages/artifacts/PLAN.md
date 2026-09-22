# Artifact refinement

This plan includes integration context from the Agents repository. References to
Studio, Boards, Modules, and its database describe consumers outside this package.

Agreed direction and API. Boards use ordinary artifacts. Native widget compatibility is removed.

## Implementation progress

- Portable registry and reference resolution implemented, with in-memory integration coverage and browser bundle checks.
- Module MIME constant moved to `@foundry/modules/constants`; existing consumers migrated.
- Studio presentations and reads use the portable exports. Its Module handler resolves installations/routes asynchronously; the replaced UI selection engine and orphaned demo are removed.
- Historical text, composition, and segmentation previews use selected Content. Static serving supports raw trees and Studio outputs, preserving nested relative asset paths and current-artifact origins.
- Module defaults use a sole active installation and a declared `/` route or sole View. Ambiguity is unavailable; existing installation-specific navigation supplies host context.
- Boards persistence and direct reference rendering are implemented. Tiles hold direct references, protected by database deletion guards. Portable file responses live in `@foundry/artifacts/delivery`. Foundry synchronization remains a separate delivery action.

## Direction

- Artifacts remains the portable owner of identity, Content, entries, versions, and storage.
- Add portable type recognition, registration, and reference resolution there.
- Studio registers its domain behavior and supplies its renderers and runtime integrations.
- Retire Widget as a special stored artifact type. A board item points to an Artifact, optionally selecting Content and a path. Module behavior belongs to its registered handler.
- Composition and segmentation retain their different contracts while sharing a generic presentation fallback.
- Preserve document images as ordinary entries. External image URLs remain external.

Confirmed scope:

1. HTML/media recognition belongs in Artifacts as portable built-ins. Studio registers document, element, composition, segmentation, and module-specific behavior.
2. “Only HTML, media, and modules” applies to the board/embed offering. Documents, codebases, and other Studio-specific artifacts remain supported elsewhere.

## Baseline evidence

| Area           | What the source does                                                                                                                 | Consequence                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Artifact model | `Artifact.type` is an open, nonempty string; entries have their own MIME.                                                            | A generic Artifact already exists. No new storage class is needed.                                      |
| Registry       | Studio registers React renderers through UI's editor registry. Matching also depends on intent.                                      | Extract selection and registration, not the React implementation.                                       |
| References     | Studio resolves current Content, explicit Content, and Module Views in its API/router and shared schemas.                            | Current/explicit Content ownership checks are reusable. Module installations remain host-owned.         |
| Composition    | V1 retains Element inputs and supplied files. V2 also holds generated still/sequence outputs, history, and assembly metadata.        | It is not merely a read-only snapshot; preserve generation, selection, provenance, and retained inputs. |
| Segmentation   | Generation writes JSON mask/track manifests, PNG entries, and sometimes a preview video. No Element or graph membership is required. | Structured data with media entries; a specialized reader, not a new graph-node class.                   |
| Graph          | Graph placements already reference Artifact IDs. Element relationships are a separate Studio concept.                                | Graph membership does not determine an artifact's storage type.                                         |
| Serving        | Studio's protocol assumes `outputs/`, reads a `profile` file, and applies app-specific CSP/isolation policy.                         | Generic tree reads are portable; these path and security conventions are not universal.                 |

Sources:

- [Artifact contracts](src/substrate.ts), [root resolution](src/system.ts), [metadata](src/tree.ts).
- [Studio registry](../../apps/studio/src/app/artifacts/registry.tsx), [UI registry](../ui/src/canvas/editors/registry/registry.ts), [React contract](../ui/src/canvas/editors/registry/types.ts).
- [Presentation contracts](../../apps/studio/src/shared/artifact-presentation.ts), [reference reads](../../apps/studio/src/main/api/router/artifacts/index.ts), [graph placements](../../apps/studio/src/shared/artifact-containers.ts).
- [Composition contracts](../../apps/studio/src/shared/compositions.ts), [service](../../apps/studio/src/main/compositions/service.ts), [generation](../../apps/studio/src/main/generative/composition-generation.ts).
- [Segmentation outputs](../generation/src/operations/definition.ts), [operation types](../generation/src/operations/types.ts).
- [HTML authoring](../../apps/studio/src/main/widgets/authoring.ts), [sharing](../../apps/studio/src/main/agents/widgets/occurrences.ts), [layout schema](../ui/src/widgets/schema.ts).
- [Artifact protocol](../../apps/studio/src/main/artifacts/protocol.ts), [Studio file conventions](../../apps/studio/src/main/artifacts/index.ts), [Module View resolution](../../apps/studio/src/app/modules/module-view-surface.tsx).

## Vocabulary and proposed model

| Term         | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Artifact     | Stable identity and its active Content pointer.                                                 |
| Content      | One version's entry tree and semantic metadata.                                                 |
| Entry        | A file or structural entry using Core's storage contract.                                       |
| Type         | The registered identity currently stored in `Artifact.type`.                                    |
| Base         | A reusable classification declared by a type definition; computed, not another database column. |
| Placement    | An occurrence of an Artifact reference in a board, Space, or Graph, with local geometry.        |
| Presentation | Host behavior for displaying or editing the selected artifact/file/view.                        |

Keep `Artifact.type` and file `mime` distinct: a composition can contain JSON, images, and video. Classifying its package does not change the MIME of any entry.

Recommended first step: register existing specialized types against canonical bases. Do not rewrite persisted identifiers or add a second discriminator merely to share behavior. If canonical persisted type names are also desired, decide that separately after the registry is working.

| Portable base     | Recognition/fallback                                                                    | Studio additions                                      |
| ----------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| HTML              | `text/html`, compatible `+html` types                                                   | Authoring workflows and Hyperframe behavior           |
| Media             | `image/*`, `video/*`, `audio/*`, retaining the concrete MIME                            | Image/video tools, provider selection                 |
| Text              | `text/*` after HTML recognition                                                         | Text generation, specialized editors                  |
| Structured data   | JSON and registered specializations; inspect entries/metadata without assuming a schema | Composition, segmentation, document-specific behavior |
| Generic file/tree | Unknown types remain readable/catalogable                                               | Host decides whether to offer an editor               |

“Structured data” is a presentation family, not an assertion that every existing composition has a JSON entrypoint. Composition currently stores its snapshot in Content metadata. Preserve that authoritative representation; do not copy it into a second manifest for classification alone.

Module behavior is an extension registered by Studio using contracts from `@foundry/modules`. A MIME string never grants execution capability. Move `MODULE_MIME` from Artifacts to its Module owner and update its consumers.

Composition and segmentation can share the structured fallback without a common payload schema or class hierarchy. Element species and named asset variants retain their existing meaning. Do not add a new `NodeArtifact` concept.

## Portable interfaces

Agreed surface:

- `@foundry/artifacts/references`: `ArtifactReference`, `ArtifactReferenceSchema`, asynchronous `resolveReference(artifacts, { artifactId, contentId?, path? })`.
- `@foundry/artifacts/registry`: `createRegistry<Handler>({ handlers, fallback })`, `register({ type, base?, handler? })`, and synchronous `resolve(target)` returning the selected handler.
- Built-in handler slots: HTML, image, video, audio, text, and structured data. Exact registration wins over the base handler, then the required fallback.
- Handlers are caller-owned values and may perform asynchronous work. Registration and matching do not execute them.
- No requester abstraction. Existing storage/lifecycle methods stay intact; `@foundry/artifacts/delivery` exposes `fileResponse(artifacts, content, path, { range?, headers? })`.

| Interface                     | Responsibility                                                                                                                               | Excluded                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Artifact registry             | Register type definitions and caller-supplied handlers; resolve exact specialization, then base, then generic fallback                       | React, icons, agents, global singleton, implicit Module startup                             |
| Artifact reference resolution | Resolve current or explicit Content, verify Artifact ownership, optionally select a root-relative entry, return explicit unavailable results | Graph/layout membership, session selection, installation state                              |
| File delivery                 | Reuse entry MIME, root selection, and ranged streaming; later expose portable response construction if extraction reduces actual duplication | `foundry:` registration, Electron, Studio CSP/COOP/COEP, an unconditional `outputs/` prefix |

The registry should accept a caller-defined handler value. Studio's value can contain React presentations; a CLI's can contain inspection/export functions. Neither implementation enters the package.

Definitions may name one base. No multiple inheritance or generic plugin lifecycle. Reject duplicate definitions; make specificity explicit rather than relying on registration order. Keep HTML/media recognition reusable through existing Lib MIME helpers.

The shared reference is `{ artifactId, contentId?, path? }`. Omitted `contentId` uses current Content; supplied `contentId` selects that version. No `selection` or separate Module View reference. A Content ID selects a row; immutability requires frozen Content. Reads must not freeze it automatically.

Resolve identity and Content before choosing the registered handler. Missing a default file does not make the artifact unavailable: composition metadata and Module runtime behavior may need no static entry.

For file presentation, use an explicit path first, then `metadata.entry`, then the existing `rootPath()` fallbacks: sole file or root `index.html`. With no match, return the artifact/tree without a selected file. Preserve an unmatched explicit path for the handler: it may name a Module route. A file-serving handler must report a missing file rather than substitute another. Invalid storage paths and broken declared entries fail resolution. File selection does not itself authorize public serving.

Studio build output should declare its presentation entry in Content metadata. `studioMetadata()` already points to `outputs/<profile.entrypoint>` or `outputs/index.html` when that file exists. Preserve this output preference; do not guess a source file when build output is absent.

Studio registers the Module handler. It owns installation lookup, declared route resolution, and the served URL while preserving runtime checks. The Module manifest's `program.entry` launches the server; it is not a browser entry. Current Module builds do not guarantee a static `metadata.entry`. Multiple installations or Views require an explicit Module-owned default rule; never pick the first implicitly. Simplify the caller reference without treating a static path as runtime authorization.

## Boards persistence

`apps/studio/src/main/widgets/boards.ts` owns `createBoards(settings)`:

```ts
boards.load(); // { version: 1, boards: Board[] }
boards.create({ label, columns, rowHeight, gutter }); // empty Board; no activation
boards.save(board);
boards.remove(boardId);
```

| Settings key      | Stored shape                                                   |
| ----------------- | -------------------------------------------------------------- |
| `widgets:layouts` | `{ activeId }`; existing runtime selection                     |
| `boards`          | `{ version: 1, boards }`; board metadata, grid geometry, tiles |

Each tile has its own ID, geometry, and `reference: { artifactId, contentId?, path? }`. It stores no renderer `type` or content `data`.

| Stage             | Changes                                                                             | Status      |
| ----------------- | ----------------------------------------------------------------------------------- | ----------- |
| 1. Persistence    | Board/Tile schemas; load/create/save/remove; serialize writes                       | Implemented |
| 2. Initialization | Create an empty default board; require artifact references on every tile            | Implemented |
| 3. Adapter        | Derive renderer documents from boards; preserve tile IDs through saves and forks    | Implemented |
| 4. Rendering      | Resolve HTML/media/Module references, including explicit Content and relative paths | Implemented |
| 5. Authoring      | Generate ordinary HTML files; preserve sessions, sharing rules, and history         | Implemented |

Board schemas live in `apps/studio/src/shared/widget-boards.ts`; persistence and layout operations live in `apps/studio/src/main/widgets`.

## Widgets become placements

Tiles reference artifacts directly. HTML/media use the shared registry; Modules use Studio's asynchronous handler. Geometry, removal, and forks target tile IDs. Shared artifacts require a fork before editing. Explicit Content previews are read-only. Removing a tile does not delete its artifact. Database guards protect referenced artifacts and selected Content.

Native manifests, embedded wrappers, JSON-render templates, runtime bundling, and old settings adoption are unsupported. Existing artifact files are not rewritten or deleted. A temporary, one-time startup cleanup resets boards and old layout settings. The unused pin table is removed by a generated migration. New boards start empty; authoring creates ordinary HTML artifacts.

## Extraction ownership

| Move into Artifacts                                                      | Keep outside Artifacts                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Type definitions/base resolution and handler registry                    | Studio domain registrations and React presentations              |
| Current/explicit Content reference resolution and entry selection        | Layouts, graph edges, Element identity/species                   |
| Existing range-reading integration; portable delivery logic where earned | Electron protocols, URLs, CSP, isolation, installed Module proxy |
| Generic unavailable-result vocabulary                                    | tRPC, settings, conversation binding, generation providers       |

Core keeps dependency-free contracts; Lib keeps path/MIME/encoding helpers. SQLite stays in DB. Node filesystem behavior remains under `/node`. Proposed Artifacts leaf exports are `/registry` and `/references`; add a delivery entrypoint only with a concrete extracted implementation. Do not move Studio's whole artifact folder or its `source/outputs/profile` convention into the package.

## Delivery order

Each phase is independently reviewable. Estimates describe relative effort, not elapsed time.

### 1. Portable registry — medium

| Change                                                                                                         | Verify                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Add type/base definitions and a React-free registry; register portable recognition rules                       | Exact, base, and unknown fallback; duplicate handling; independent registries                    |
| Adapt Studio registrations and UI's React binding to the shared resolver; remove the replaced selection engine | Existing handler/intent/capability choices remain correct                                        |
| Move Module type constant ownership; update Module and Studio consumers                                        | Artifacts root has no Module/Studio imports                                                      |
| Prove use from an in-memory non-Studio host                                                                    | Resolve and inspect HTML, media, structured, and unknown artifacts without React/Electron/SQLite |

### 2. Shared references — medium

| Change                                                                                                         | Verify                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Extract current/explicit Content resolution from Studio's router, including ownership and unavailable outcomes | Missing, wrong-owner, ready, frozen, generating, failed, and no-content cases         |
| Make composition and segmentation presentations consume the selected Content                                   | Historical previews do not silently fetch the active version                          |
| Resolve Module artifacts through Studio's registered handler; remove separate public View references           | Declared route/default resolution; inactive installation refusal; no file-path bypass |

### 3. Direct artifact placements — medium/large

| Change                                                                                    | Verify                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Separate layout occurrence ID from artifact reference; render through the shared registry | Same artifact twice, handler-resolved Module routes, independent geometry           |
| Replace embedded-widget indirection with direct references                                | Exact Content selection, shared edits/forks, sessions and deep links preserved      |
| Protect board references in the database                                                  | Referenced Content cannot disappear; removing one occurrence does not break another |

### 4. Ordinary HTML authoring

| Change                                                                | Verify                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Route new small-app authoring to ordinary HTML or Module artifacts    | Plain HTML stays self-contained; privileged/persistent behavior uses the agreed host/Module mechanism |
| Remove native renderers, templates, converters, and settings adoption | Empty-board initialization and plain artifact files                                                   |
| Remove specialized widget APIs, projections, and pin storage          | Direct references, shared-edit policy, and deletion protection                                        |

### 5. Serving and domain cleanup — medium

| Change                                                                                | Verify                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Extract portable file/range response logic after references are settled               | Raw-tree HTML with relative assets, existing `outputs/` artifacts, media seeks, cancellation                   |
| Keep public-path policy explicit in Studio; retain protocol and sandbox behavior      | Source/profile files do not become public accidentally; CSP and isolation unchanged                            |
| Consolidate composition/segmentation recognition through their registered definitions | Existing payloads, generation contribution rules, provenance, masks/tracks, assembly, and history remain valid |
| Remove superseded adapters/import paths once consumers migrate                        | Second host works without Studio; no permanent one-to-one compatibility barrels                                |

## Blast radius and limits

Primary: Artifacts, Studio artifact presentation/router/protocol code, widget board and authoring code. Supporting: UI registry and board contracts, DB retention/layout migration, Modules constant imports, Generation's segmentation/type integration.

No redesign of blob identity, Content lifecycle, pagination, storage contracts, sandbox policy, or Workspaces. No automatic conversion of rich-text documents into HTML. No new universal graph/relationship database. Foundry repository synchronization is a separate delivery action.

## Specific issues to carry into implementation

- Composition preview calls `compositions.get(artifactId)` and segmentation preview calls `artifacts.get(artifactId)`, ignoring an already selected historical Content. Resolve once and pass that selection through.
- The generic protocol prefixes non-root paths with `outputs/`. A plain tree containing `index.html` and `style.css` is not served consistently by that convention. Preserve old URLs while making new root-relative references explicit.
- Current composition availability probes query SQLite blobs by digest. Replace this with artifact entry/reference reads if those availability checks need to run in another host; do not expose raw blob-table queries as a new universal contract.

## Plain artifact files

HTML authoring stores the returned files directly. Studio adds no state client, injected scripts, persistence bridge, or state endpoint. HTML previews render artifact files; interaction does not write back into Content. Editing uses the normal artifact write/revise operations and preserves omitted supporting files.

## Temporary cleanup

`apps/studio/src/main/widgets/cleanup.ts` resets boards, layout documents, active selection, and layout-session settings once at startup. The completion marker and deletions share a transaction. Subsequent starts preserve new boards. Artifact files and Session records remain intact. Remove this temporary cleanup after existing profiles have reset.

## Validation

- 37 focused tests passed for cleanup, authoring, boards, and startup lifecycle.
- 35 Electron tests passed for artifact rendering and generation, including HTML interaction without Content mutation.
- Build, typecheck, changed-source lint, and main-process build boundary passed.
- No development database changes or dev server startup. The reset runs on the next Studio startup.
