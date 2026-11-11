---
title: Installation
description: Install the standalone Marbles CLI and prepare your own project.
---

Marbles requires **Bun 1.3.14 or newer**. Check with `bun --version`.
Automations using only TypeScript and local commands need no agent account
or sandbox runtime.

## Install the package

Marbles is packaged as `@foundry.sh/marbles`, with a `marbles` executable and
TypeScript declarations. It bundles its Foundry libraries so it can run
independently of the Foundry repository.

The [bundled libraries](/marbles/foundation/primitives) need no separate
installation. Their documentation explains the operations behind Marbles.

Install the published package:

```sh
bun add --global @foundry.sh/marbles@0.0.3
marbles --help
```

The docs follow the source checkout, so features added after a release may
require a [checkout-built archive](/marbles/contributing#build-a-distributable-package).
See [release status](/marbles/library#release-status).

If the shell cannot find `marbles`, put Bun's global binary directory on
`PATH`; `bun pm bin --global` prints it. A successful installation prints
the Marbles commands when you run `marbles --help`.

Maintainers can [build a package archive](/marbles/contributing#build-a-distributable-package).
Package building is separate from writing and running your own automations.

## Editor types and project dependencies

The CLI supplies `@foundry.sh/marbles` and `@foundry.sh/marbles/prebuilt` when it
loads an automation, even if your project has neither installed. For editor
completion and TypeScript checking, install the same package in your project,
with TypeScript 6:

```sh
bun add --dev @foundry.sh/marbles@0.0.3 typescript@^6
```

Marbles names a definition built without a name after the `const` it is
assigned to, using your project's TypeScript to read the source. TypeScript 7
has no parser Marbles can call, so it counts as absent; without TypeScript 6,
give each launchable definition a name.

Keep the project package and global CLI on the same artifact. If using a
checkout archive, install that archive in both places: an npm release and a
checkout archive can share a version number but expose different APIs. Other libraries
your automation imports must be installed in that project. The quickstart
needs only Marbles; later examples state their additional dependencies.

## Add optional capabilities when needed

| Capability | Additional setup |
| --- | --- |
| Agent turns | An installed and authenticated Claude Code, Codex, or Pi CLI on `PATH`. Test it directly first. |
| Typed input | A Standard Schema library. These docs use `zod`. |
| Git worktrees | Git and a repository with at least one commit. |
| Sandbox execution | The optional `microsandbox` SDK and its native runtime; see [sandboxes](/marbles/foundation/workspaces-and-sandboxes#sandboxes). |
| Environment validation | Varlock and a project `.env.schema`; see [environment](/marbles/reference/project#environment). |

Continue with [Your first automation](/marbles/get-started/quickstart).
