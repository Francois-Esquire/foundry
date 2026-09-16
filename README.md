# Foundry

[![CI](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/Francois-Esquire/foundry/actions/workflows/ci.yml?query=branch%3Amain)
[![Publish](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml/badge.svg)](https://github.com/Francois-Esquire/foundry/actions/workflows/publish.yml)
[![Documentation](https://img.shields.io/badge/docs-Quirks-2563eb)](https://francois-esquire.github.io/foundry/quirks/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](package.json)
[![Bun](https://img.shields.io/badge/Bun-1.3.14-14151a?logo=bun&logoColor=white)](package.json)
[![Turborepo](https://img.shields.io/badge/build-Turborepo-ef4444?logo=turborepo&logoColor=white)](turbo.json)
[![Code checks](https://img.shields.io/badge/code_checks-Ultracite-60a5fa)](biome.jsonc)
[![Documentation site](https://img.shields.io/badge/docs_built_with-Blume-8b5cf6)](blume.config.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Tools and TypeScript libraries for building local behaviors with coding agents.

A coding-agent harness becomes something you build with. Combine ordinary code,
agent conversations, files, and Git into work that can run once, react to a
change, or return on a schedule.

## Start with Quirks

[Quirks](apps/quirks/README.md) turns recurring behaviors into inspectable
TypeScript. A `quirks.config.ts` defines the work, where an agent participates,
and what makes it run again. Claude Code and Codex are its current execution
harnesses for model turns.

Use it to watch repository instructions for drift, keep a reviewer that remembers
earlier revisions, or compose implementation and review with ordinary checks.
Small behaviors can stay small. A deterministic step needs no model call.

[Documentation](https://francois-esquire.github.io/foundry/) ·
[Start here](https://francois-esquire.github.io/foundry/quirks/start-here/) ·
[Concepts](https://francois-esquire.github.io/foundry/quirks/concepts/) ·
[Use cases](https://francois-esquire.github.io/foundry/quirks/use-cases/) ·
[API reference](https://francois-esquire.github.io/foundry/quirks/reference/factories/)

## A few simple ideas

- A **step** does one piece of work. A **workflow** connects those pieces.
- An **agent** supplies instructions. A **session** retains its conversation.
- A **monitor** reacts to changes. A **schedule** decides when work returns.
- A **workspace** gives the behavior a directory and a place for its saved state.

Quirks runs through a command, a foreground loop, or fresh processes scheduled
by macOS launchd. State lives on disk between invocations. Custom code keeps its
normal side effects; read the [safety and limits](https://francois-esquire.github.io/foundry/quirks/safety-and-limits/).

## In this repository

| Part | Purpose |
| --- | --- |
| [Quirks](apps/quirks) | The local CLI and configuration API. |
| [Agents](packages/agents) | Agent execution and retained conversations. |
| [Workflows](packages/workflows) | Steps, composition, and execution state. |
| [Models](packages/models) | Model providers and coding-agent harness access. |
| [Workspaces](packages/workspaces) | Directory inventories and Git operations. |

Quirks is currently the only package configured for public npm releases. The
shared libraries are private workspace packages bundled into it.

## Contributing

Development uses Bun and Turborepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for
setup, checks, documentation development, and publishing.

## License

[MIT](LICENSE)
