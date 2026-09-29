# Foundry

[![CI](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml?query=branch%3Amain)
[![Publish](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml/badge.svg)](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml)
[![Documentation](https://img.shields.io/badge/docs-Foundry-2563eb)](https://francois-esquire.github.io/foundry/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](package.json)
[![Bun](https://img.shields.io/badge/Bun-1.3.14-14151a?logo=bun&logoColor=white)](package.json)
[![Turborepo](https://img.shields.io/badge/build-Turborepo-ef4444?logo=turborepo&logoColor=white)](turbo.json)
[![Code checks](https://img.shields.io/badge/code_checks-Ultracite-60a5fa)](biome.jsonc)
[![Documentation site](https://img.shields.io/badge/docs_built_with-Blume-8b5cf6)](docs/blume.config.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

TypeScript tools and libraries for working on codebases locally. Some of them
bring coding agents into the work; all of them run on your machine, keep their
state on disk, and send nothing anywhere unless you tell them to.

Foundry is a Bun and Turborepo workspace. Two of its packages are published to
npm; the rest are the shared libraries they are built from.

## Tools

| Package | What it does | Read more |
| --- | --- | --- |
| [Quirks](apps/quirks) | Turns recurring behaviors into inspectable TypeScript. A `quirks.config.ts` defines steps, workflows, agents, schedules, and monitors, then runs them once, in a foreground loop, or from launchd. | [README](apps/quirks/README.md) · [Docs](https://francois-esquire.github.io/foundry/quirks/) |
| [Atlas](apps/atlas) | Draws a workspace of TypeScript packages as a map you explore in the browser. Packages are islands placed by dependency, files are their settlements. | [README](apps/atlas/README.md) · [Docs](https://francois-esquire.github.io/foundry/atlas/) |

Both are configured for public npm releases as `@foundry/quirks` and
`@foundry/atlas`, from one shared version. The first release has not shipped
yet; until then, run them from this repository.

## Libraries

Private workspace packages. Quirks bundles the ones it uses.

| Package | What it does |
| --- | --- |
| [agents](packages/agents) | The agent runtime: a tool-calling loop over an AI SDK model, a persisted conversation, MCP servers, skills, and an authorization gate on every tool call. |
| [workflows](packages/workflows) | A durable workflow runtime. Steps compose into trees, run under a queue, survive a restart, and can suspend waiting on a human. |
| [models](packages/models) | One registry over hosted gateways, on-device weights, and the coding-agent CLI harnesses, plus the catalog of what each model costs and can do. |
| [workspaces](packages/workspaces) | Durable registration of a source directory: identity, inclusion, and the last reconciled inventory of its files. |
| [artifacts](packages/artifacts) | Versioned content with stable identity, blob storage, and delivery to the filesystem. |
| [sandbox](packages/sandbox) | One `Sandbox` interface over a microVM container or an in-memory filesystem, with one set of agent tools bound to either. |
| [core](packages/core) | Dependency-free storage and pagination contracts shared by the packages above. |
| [lib](packages/lib) | Small shared helpers: paths, digests, canonical JSON, globs, MIME detection. |

`tooling/` holds the release scripts and the shared TypeScript configuration.

## Documentation

The site at [francois-esquire.github.io/foundry](https://francois-esquire.github.io/foundry/)
has a section per tool: [Quirks](https://francois-esquire.github.io/foundry/quirks/)
and [Atlas](https://francois-esquire.github.io/foundry/atlas/).

The pages live in this repository under [`docs/`](docs): [`docs/quirks`](docs/quirks/index.md)
and [`docs/atlas`](docs/atlas/index.md), built with Blume. Run the site locally with:

```sh
bun install --frozen-lockfile
bun run docs:dev
```

Each package README covers its own API and development commands.

## Contributing

Development uses Bun and Turborepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for
setup, checks, documentation development, and publishing.

## License

[MIT](LICENSE)
