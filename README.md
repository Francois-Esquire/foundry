# Foundry

[![CI](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml?query=branch%3Amain)
[![Publish](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml/badge.svg)](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml)
[![Documentation](https://img.shields.io/badge/docs-Foundry-2563eb)](https://francois-esquire.github.io/foundry/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](package.json)
[![Bun](https://img.shields.io/badge/Bun-1.3.14-14151a?logo=bun&logoColor=white)](package.json)
[![Turborepo](https://img.shields.io/badge/build-Turborepo-ef4444?logo=turborepo&logoColor=white)](turbo.json)
[![Code checks](https://img.shields.io/badge/code_checks-Ultracite-60a5fa)](biome.jsonc)
[![Documentation site](https://img.shields.io/badge/docs_built_with-Blume-8b5cf6)](apps/documentation/blume.config.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

TypeScript tools and libraries for working on codebases locally. Some of them
bring coding agents into the work; all of them run on your machine, keep their
state on disk, and send nothing anywhere unless you tell them to.

Foundry is a Bun and Turborepo workspace. Marbles and Spyglass are configured as
standalone npm packages; the shared libraries they bundle remain private.

## Tools

| Package | What it does | Read more |
| --- | --- | --- |
| [Marbles](apps/marbles) | Turns recurring automations into inspectable TypeScript. Modules in `.foundry/marbles/` define steps, workflows, agents, schedules, and monitors. Run them once or keep Marbles running in a terminal. | [README](apps/marbles/README.md) · [Docs](https://francois-esquire.github.io/foundry/marbles/) |
| [Spyglass](apps/spyglass) | Draws a workspace of TypeScript packages as a map you explore in the browser. Packages are islands placed by dependency, files are their settlements. | [README](apps/spyglass/README.md) · [Docs](https://francois-esquire.github.io/foundry/spyglass/) |

Apps release independently. Marbles and Spyglass are published to npm as
`@foundry.sh/marbles` and `@foundry.sh/spyglass`. Both are alpha on `0.0.x`,
with breaking changes allowed until the `0.1.0` API milestone. Shared libraries
have one synchronized internal version and remain private, without their own
release PRs or GitHub Releases. GitHub Releases are cut from a green `main`;
npm publication of each release then waits for a protected approval.

## Libraries

Private workspace packages. Marbles bundles the ones it uses.

| Package | What it does |
| --- | --- |
| [agents](packages/agents) | The agent runtime: a tool-calling loop over an AI SDK model, a persisted conversation, MCP servers, skills, and an authorization gate on every tool call. |
| [workflows](packages/workflows) | A durable workflow runtime. Steps compose into trees, run under a queue, survive a restart, and can suspend waiting on a human. |
| [tasks](packages/tasks) | The backlog: what there is to do, what is ready, what is done. Tasks with dependencies and parents, derived availability, and one atomic batch command. Execution stays in workflows. In memory by default; a `TaskStore` persists it. |
| [prompts](packages/prompts) | Prompt dialects for Claude Code, Codex, and Pi: what a prompt references (skills, agents, files), checked against what a host has, and written in each harness's notation. |
| [usage](packages/usage) | Usage per AI provider account as it is now: limits and consumption across allowance, metered, prepaid, and credit billing. Marbles reads it to route an agent. |
| [models](packages/models) | One registry over hosted gateways, on-device weights, and the coding-agent CLI harnesses, plus the catalog of what each model costs and can do. |
| [workspaces](packages/workspaces) | Durable registration of a source directory: identity, inclusion, and the last reconciled inventory of its files. |
| [artifacts](packages/artifacts) | Versioned content with stable identity, blob storage, and delivery to the filesystem. |
| [sandbox](packages/sandbox) | One `Sandbox` interface over a microVM container or an in-memory filesystem, with one set of agent tools bound to either. |
| [modules](packages/modules) | Artifact-backed Modules: packaging, installation, and the contracts that connect a Module program to host capabilities, with an in-memory Store and Program supervision. |
| [core](packages/core) | Dependency-free shapes the packages above share: agent, skill, and MCP declarations, the reference protocol, storage, and pagination. |
| [lib](packages/lib) | Small shared helpers: paths, digests, canonical JSON, globs, MIME detection. |

`tooling/` holds the release scripts, the shared TypeScript configuration, and
the prompt tooling: [linting](tooling/linting) checks what a prompt references
through ESLint, Oxlint, and Biome, and the [VS Code extension](tooling/vscode-extension)
highlights those references in the editor.

[`packages/modules`](packages/modules) holds the Module framework and SDK.
The Documents Module is developed independently on the `feat/documents` branch.

## Documentation

The site at [francois-esquire.github.io/foundry](https://francois-esquire.github.io/foundry/)
has a section per tool: [Marbles](https://francois-esquire.github.io/foundry/marbles/),
[Spyglass](https://francois-esquire.github.io/foundry/spyglass/), and
[Prompts](https://francois-esquire.github.io/foundry/prompts/).

The pages live in this repository under [`apps/documentation/`](apps/documentation): [`apps/documentation/marbles`](apps/documentation/marbles/index.md),
[`apps/documentation/spyglass`](apps/documentation/spyglass/index.md), and [`apps/documentation/prompts`](apps/documentation/prompts/index.md), built with Blume. Run the site locally with:

```sh
bun install --frozen-lockfile
bun run docs:dev
```

Each package README covers its own API and development commands.

## Desktop app

[`apps/works`](apps/works) is Foundry Works, an Electron desktop app for
building and running Modules: a module library with source editing, versioned
sandbox releases, and each module run as a micro-app. It is private and not
released. Run it with `bun run dev --filter=@foundry/works`.

## Website

[`apps/website`](apps/website) is the static Astro marketing site for
foundry.sh. It introduces the broader creation-tooling vision and links to the
documentation. Run it with `bun run dev --filter=@foundry/website`.

## Contributing

Development uses Bun and Turborepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for
setup, checks, documentation development, and publishing.

## License

[MIT](LICENSE)
