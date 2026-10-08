# Modules glossary

This glossary defines language used by `@foundry/modules`. It separates Module-domain
terms from Artifact storage, host orchestration, and transport representations.

## Identity and version terms

| Term               | Meaning here                                                                                                               | Distinguish from                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Module             | Stable control-plane identity for one Module Artifact                                                                      | The Artifact, a version, or a running Program               |
| Module ID          | Identifier preserved across versions and Installations                                                                     | Artifact ID, Content ID, or Installation ID                 |
| Module Artifact    | The `application/vnd.foundry.module` Artifact that owns a Module's changing Content                                        | Module identity, which remains a separate Store record      |
| Version            | A frozen, SemVer-tagged Content of the Module Artifact with a valid Manifest, resolved on demand by `contentId`            | A persisted record; none exists                             |
| Module Manifest    | Canonical declaration of compatibility, one Program entry, Views, capability requests, and optional data paths             | Host policy, granted authority, or runtime state            |
| Embedded manifest  | `source/foundry.module.json` inside a Content; the manifest of every built version                                         | The retained manifest                                       |
| Retained manifest  | Store copy for a Content that cannot supply its own (output-only import, legacy disagreement); outranks embedded           | A cache; it is the only copy, and frozen bytes never change |
| Module Package     | Canonical `foundry.module/3` transport envelope for one version and its bytes                                              | A workspace, npm package, or second version model           |
| Program checkout   | Host directory holding one version's verified `outputs/`, named by Content digest, mounted read-only                       | An Artifact directory, which follows the active Content     |
| Installation files | Host directory owned by one Installation, mounted read-write; holds `data.sqlite`, its `.bak`, or an empty-baseline marker | The checkout, which Installations share                     |

Gateway protocol 1 still names the pinned Content `releaseId` in its hello frame. That
is a wire obligation, not domain vocabulary.

## Installation and runtime terms

| Term                | Meaning here                                                                                 | Consequence                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Installation        | Durable selection and lifecycle record for one Module                                        | It owns its selected `contentId`, status, start attempts, generation, container ID, and Grants |
| Installation status | One of `disabled`, `starting`, `active`, `stopping`, or `failed`                             | It combines operator and occurrence state in the current model                                 |
| Start attempts      | Consecutive failed starts since the last reset                                               | Active settlement, explicit user start, or version selection resets it                         |
| Generation          | Compare-and-set token for Installation transitions and runtime identity currency             | Starting, stopping, and version selection increment it; settlement does not                    |
| Runtime identity    | Host-bound Installation, Content, runtime instance ID, and generation of one running Program | It is stale after selection or generation changes; never accepted from the guest               |
| Program             | Released executable content that connects through the Gateway                                | The host runtime, Module identity, or workspace application UI                                 |

The package does not currently define separate desired, activation, or recovery state
axes. A host may coordinate richer workflows, but package documentation must not project
those workflows into `Installation`.

## Capability and Gateway terms

| Term                | Meaning here                                                                                | Distinguish from                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Capability          | Versioned, owner-namespaced host action with unary or stream mode                           | A Manifest alias or a Grant                                        |
| Capability request  | Manifest declaration that a Program wants one Capability                                    | Approval; a request grants nothing                                 |
| Capability alias    | Installation-local name used by the Program to invoke a requested Capability                | The owner-namespaced Capability name                               |
| Capability catalog  | Immutable portable description of host registrations at one generation                      | Provider implementations or Installation Grants                    |
| Capability provider | Host registration plus constraint resolution and effect implementation                      | The portable catalog descriptor exposed to Programs                |
| Grant               | Stored approval for one capability, version, and constraints digest on an Installation      | A Manifest request or provider registration                        |
| Constraints digest  | Content-derived identity used to match resolved host policy to a Grant                      | The constraints object itself                                      |
| Module Gateway      | Host-owned framed connection and session boundary for development catalogs or runtime calls | A transport, provider, or lifecycle supervisor                     |
| Principal           | The runtime identity plus the Module ID, given to a provider                                | Program-supplied input                                             |
| Invocation          | One Gateway request admitted to a provider under a Principal and Grant                      | Durable evidence; this package does not persist invocation records |

## Workspace terms

| Term                       | Meaning here                                                                               | Distinguish from                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Module base                | Application file tree, with `id`, `name`, and optional `instructions`, a workspace starts from | A catalog entry; choosing which bases to offer is outside this package |
| Module Template            | Composed workspace built from an eligible Module base plus composer-owned files            | A Module Package or released Content                                  |
| Module SDK pack            | Integrity-checked files injected into a generated workspace as local `@foundry/module-sdk` | The `src/sdk/` modules that build the pack; workspaces never import them |
| Development session        | Gateway session bound to a development ID and capability catalog                           | Runtime session; it cannot dispatch provider effects                  |
| Development source binding | Artifact ID, Content ID, and revision captured when a workspace opens                      | A save may advance this binding only after passing its conflict check |
| Runtime session            | Gateway session bound to one runtime identity                                              | Installation lifecycle control or Program process ownership           |

See [Architecture](ARCHITECTURE.md) for ownership and flows and the
[README](README.md) for package use.
