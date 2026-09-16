# foundry

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Husky** - Git hooks for code quality
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

Then, run the development server:

```bash
bun run dev
```

## Environment Configuration

Each app owns its environment schema in `.env.schema`. Varlock generates `src/env.ts` during installation; run `bun run env:generate` after changing a schema. Commit schemas, and keep secrets in ignored env files or your deployment platform.

Import the generated `ENV` accessor in application code. Shared database and auth packages receive configuration or initialized clients from the application. See [Varlock's monorepo guide](https://varlock.dev/guides/monorepos/).

Bun's automatic env loading is disabled in `bunfig.toml`; the framework integration or server bootstrap loads Varlock. Node deployments must include Varlock and its dependencies alongside the app schema.

## Git Hooks and Formatting

- Initialize hooks: `bun run prepare`

## Project Structure

```text
foundry/
├── apps/
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run check-types`: Check TypeScript types across all apps

## Continuous integration

GitHub Actions runs a frozen-lockfile install, lint and formatting checks, and
TypeScript checks on pull requests and pushes to `main`. The Bun version comes
from `packageManager` in the root `package.json`. Dependabot checks for GitHub
Actions updates weekly.

Run the same checks locally:

```bash
bun install --frozen-lockfile
bun run check
bun run check-types
```

Add build and test steps when packages define those scripts. Currently no package
has a build script or test suite, so CI does not claim to validate either.
