# @foundry/core

The shapes other Foundry packages share, so they can agree on them without
depending on each other. Mostly types, a few small helpers over them, and no
runtime dependencies. Private to the workspace.

| Entry | What it holds |
| --- | --- |
| `@foundry/core/agents` | What an agent is made of: `AgentSpec`, `Skill`, the MCP server shapes (`McpServerDefinition`, its transports and status), and the reference protocol (`Reference`, `REFERENCE`, `referenceSource`, `withReference`). |
| `@foundry/core/pagination` | `Page` and `PageInput`, the cursor page that list operations return and take. |
| `@foundry/core/storage` | The `Storage` contract (reader, writer, atomic writes, observers), its file and directory nodes, storage trees with their path rules, and the conflict errors. |
| `@foundry/core/testing/storage` | `storageChecks`: conformance checks a `Storage` implementation runs in its own test runner against a `StorageFixture`. |

## Why it exists

Two packages that need the same shape import it from here instead of from
each other. `@foundry/prompts` and `@foundry/agents` both use the reference
protocol: prompts extends the kinds with its own notation, agents marks its
skills and agents as referenceable, and neither depends on the other. The
sandbox and workspaces storage implementations run the same
`storageChecks`.

The agent shapes reference catalog entries by name and leave runtime
settings as type parameters; the live MCP client, model settings, and
compaction stay in `@foundry/agents`.

## Development

```sh
bun run --cwd=packages/core build      # tsc into dist/
bun run --cwd=packages/core typecheck
```

The package has no tests of its own; its storage checks run in the
packages that implement `Storage`.
