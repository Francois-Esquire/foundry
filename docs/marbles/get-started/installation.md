---
title: Installation
description: Install the standalone Marbles CLI and prepare your own project.
---

Marbles requires **Bun 1.3.14 or newer**. Check with `bun --version`.
Automations using only TypeScript and local commands need no agent account
or sandbox runtime.

## Install the package

Marbles is packaged as `@foundry/marbles`, with a `marbles` executable and
TypeScript declarations. It bundles its Foundry libraries so it can run
independently of the Foundry repository.

The [bundled libraries](/marbles/foundation/primitives) need no separate
installation. Their documentation explains the operations behind Marbles.

The package is not yet available from npm. For now, install a packaged
`.tgz` supplied by a maintainer. Replace the example path with your archive:

```sh
bun add --global /absolute/path/to/foundry-marbles-0.0.1.tgz
marbles --help
```

If the shell cannot find `marbles`, put Bun's global binary directory on
`PATH`; `bun pm bin --global` prints it. A successful installation prints
the Marbles commands when you run `marbles --help`.

Maintainers can [build a package archive](/marbles/contributing#build-a-distributable-package).
Package building is separate from writing and running your own automations.

## Editor types and project dependencies

The CLI supplies `@foundry/marbles` and `@foundry/marbles/prebuilt` when it
loads an automation, even if your project has neither installed. For editor
completion and TypeScript checking, install the same archive in your project:

```sh
bun add --dev /absolute/path/to/foundry-marbles-0.0.1.tgz
```

Keep the project package and global CLI on the same version. Other libraries
your automation imports must be installed in that project. The quickstart
needs only Marbles; later examples state their additional dependencies.

## Add optional capabilities when needed

| Capability | Additional setup |
| --- | --- |
| Agent turns | An installed and authenticated Claude Code or Codex CLI on `PATH`. Test it directly first. |
| Typed input | A Standard Schema library. These docs use `zod`. |
| Git worktrees | Git and a repository with at least one commit. |
| Sandbox execution | The optional `microsandbox` SDK and its native runtime; see [sandboxes](/marbles/foundation/workspaces-and-sandboxes#sandboxes). |
| Environment validation | Varlock and a project `.env.schema`; see [environment](/marbles/reference/project#environment). |

Continue with [Your first automation](/marbles/get-started/quickstart).
