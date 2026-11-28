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

The [bundled libraries](/marbles/concepts/primitives) need no separate
installation. Their documentation explains the operations behind Marbles.

Install the published package:

```sh
bun add --global @foundry.sh/marbles@0.0.4
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
bun add --dev @foundry.sh/marbles@0.0.4 typescript@^6
```

Marbles names a definition built without a name after the `const` it is
assigned to, using your project's TypeScript to read the source. TypeScript 7
has no parser Marbles can call, so it counts as absent; without TypeScript 6,
give each launchable definition a name.

Keep the project package and global CLI on the same artifact. If using a
checkout archive, install that archive in both places: an npm release and a
checkout archive can share a version number but expose different APIs. Other libraries
your automation imports must be installed in that project. The quickstart's
first step needs only Marbles; each later example states what it adds.

## Avoid development-only peers

OpenTUI 0.5.11's published metadata makes React DevTools a required peer,
although its runtime loads it only with `DEV=true`. Its FFI dependency also
declares TypeScript 5 as a required peer without importing it at runtime.
Neither is needed to run Marbles' dashboard normally.

With Bun 1.4.5, add these version-scoped repairs to your installing project's
root `package.json`, then run `bun install`:

```json
{
  "packageExtensions": {
    "@opentui/react@0.5.11": {
      "peerDependenciesMeta": {
        "react-devtools-core": { "optional": true },
        "ws": { "optional": true }
      }
    },
    "bun-ffi-structs@0.3.1": {
      "peerDependenciesMeta": {
        "typescript": { "optional": true }
      }
    }
  }
}
```

The Foundry checkout already has these repairs. They do not propagate to
consumers through the Marbles tarball. A global installation needs them in
the package manager's global installation root, not in a workspace that
uses the global CLI. Tree-sitter stays installed for Markdown parsing and
highlighting. Keep any TypeScript dependency you explicitly use for editor
types, typechecking or inferred definition names.

## Add optional capabilities when needed

| Capability | Additional setup |
| --- | --- |
| Agent turns | An adapter installed alongside Marbles and an authenticated Claude Code, Codex, or Pi CLI on `PATH`. See below. |
| Typed input | A Standard Schema library. These docs use `zod`. |
| Git worktrees | Git and a repository with at least one commit. |
| Sandbox execution | The optional `microsandbox` SDK and its native runtime; see [sandboxes](/marbles/concepts/workspaces-and-artifacts#sandboxes). |

Continue with [your first ritual](/marbles/get-started/quickstart).

### Install a provider adapter

The checkout build leaves CLI provider SDKs out of the default installation.
They are optional peers, so installing Marbles does not download the Claude
or Codex native binaries. The current npm release still includes these SDKs.

Install only what you use, in the same project or global installation as Marbles:

```sh
# Codex
bun add --global ai-sdk-provider-codex-cli@2.4.0
# Claude Code, including the SDK used for account limits
bun add --global ai-sdk-provider-claude-code@4.4.1 @anthropic-ai/claude-agent-sdk@0.3.283 @anthropic-ai/sdk@1.12.0
# Pi
bun add --global ai-sdk-provider-pi@0.1.0
```

Omit `--global` for a project installation. Codex requires CLI 0.156.0 or newer.
Install and authenticate the CLI
itself if the adapter does not supply it, and test it directly first. Marbles
offers a CLI provider only when both its adapter and executable are available.
Restart Marbles after adding an adapter to review it in provider setup.
Detection does not import an SDK or start a provider process.
