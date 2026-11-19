# Foundry Agent Harness

An agent harness with a terminal UI, built on `@foundry.sh/marbles` as a
library. No CLI, no `.foundry/marbles` folder, no Marbles process. You give it
a goal; it plans the goal into a to-do list, works through the list, and keeps
the results as an artifact.

```sh
bun run build -F @foundry.sh/marbles
cd examples/foundry-agent-harness
bun run start
```

Run the build from the repository root. Type a goal and press Enter. Tab
moves through the side panel, PgUp and PgDn scroll the conversation, and
Ctrl+C quits. A second goal continues the same conversation and adds to the
list.

The harness needs an installed and signed-in Claude Code CLI, and each goal
spends a few real turns. The worker is your own Claude Code: it runs on the
host with your tools, in the directory you start it from.

## What it uses

| File | Holds |
| --- | --- |
| [`src/harness.ts`](./src/harness.ts) | The harness: one thread, its context, and every Marbles call. |
| [`src/backlog.ts`](./src/backlog.ts) | An MCP server in this process that lets the worker add a to-do. |
| [`src/app.tsx`](./src/app.tsx) | The screen, in [OpenTUI](https://github.com/anomalyco/opentui) React. |
| [`src/main.tsx`](./src/main.tsx) | The renderer, and the engine's disposal when it closes. |
| [`.claude/skills`](./.claude/skills) | The skills the worker gets. |
| `src/components/ui`, `src/hooks`, `src/lib` | [TermCN](https://www.termcn.dev) components, copied in by the shadcn CLI. |

| Piece | From Marbles |
| --- | --- |
| The host | `Engine` from `@foundry.sh/marbles/lib`, built from in-memory session and artifact stores and a `ModelManager` holding the Claude Code provider. |
| The planner | `agent` with a structured `Output`, so the plan comes back as a typed list instead of text to parse. |
| The to-do list | `tasks`: each planned task depends on the one before it, and the loop takes whatever `tasks.ready()` offers next. |
| The worker | One `engine.agents.session` for every task. Its `onText`, `onToolCall`, and `onToolResult` handlers feed the screen as the turn runs. |
| The result | `artifact`: each goal writes one version holding a Markdown file per task. |
| The skills | `defineSkill` reads each `SKILL.md` for its name and description. |

| On screen | Built from |
| --- | --- |
| Side panel | TermCN `Tabs`: To-dos, Notes, Skills, and MCP. |
| Conversation | TermCN `Panel`, `ChatThread`, and `ChatMessage` inside an OpenTUI `scrollbox`; tool calls are TermCN `ToolCall` rows and replies are OpenTUI `markdown`. |
| Goal | OpenTUI `input` inside a TermCN `Panel`. |

Marbles writes nothing to disk here. The engine keeps sessions and artifacts
in memory, a script without a host keeps `tasks` in memory, and all three end
with the process. Claude Code still keeps its own session history.

## Threads and their context

`harness.ts` keeps one `Thread` (its messages, to-dos, notes, and token
counts) and one `Context` (the model, skills, and MCP servers the worker
has). The screen takes both as props and holds no harness state, so a second
thread is another `Thread` value and a way to choose between them.

The Skills and MCP tabs list what the worker really has:

- **Skills** are the folders in `.claude/skills` of the directory you start
  the harness in. The worker gets these and no others.
- **MCP** is the `backlog` server from `backlog.ts`. Its `add_todo` tool
  appends a task to the same backlog the loop reads, so a to-do the worker
  adds shows up in the list and gets worked. Connectors on your Claude
  account load too and are not listed.

Both reach the worker through the Claude Code provider's own settings
(`skills`, `settingSources`, `mcpServers`). `agent({ skills, mcp })` does not
reach a Claude Code host session yet: Marbles offers them as AI SDK tools,
which the Claude Code CLI does not take.

## TermCN components

`components.json` registers the TermCN registry, so the shadcn CLI adds a
component by name:

```sh
bunx shadcn@latest add @termcn/opentui/panel
```

The CLI adds the newest `@opentui/react` to `package.json`; set it back to
the version the repository uses. The copies are yours to edit, and Biome and
Knip leave these folders alone. Three are edited:

- `tool-call.tsx` and `chat-message.tsx`: the row boxes say
  `flexDirection="row"`, because an OpenTUI box stacks its children unless
  told otherwise. `tool-call.tsx` also shows its timer in seconds.
- `tabs.tsx`: the same row fix; it fills its parent; only Tab and Shift+Tab
  switch, so the arrow keys stay with the goal field; and it no longer writes
  a clear-screen sequence to the terminal.

Not every component fits yet. `text-input` and `token-usage` do not pass this
repository's type checks, and `spinner` imports a hook written for Ink.

## Change it

- Another harness: swap `claudeCodeProvider` for `codexProvider` or
  `piProvider`, exported from the same entry.
- Keep the work: give the engine a `state` directory and a `JsonArtifactStore`.
  See [Embedding the engine](../../apps/documentation/marbles/reference/engine.md).
- Limit the worker: its prompt tells it not to edit files, which is an
  instruction and not a permission. See
  [safety and limits](../../apps/documentation/marbles/reference/safety.mdx).
- See each turn's model, tokens, and timing: remove `initLogger({ enabled:
  false })`. Marbles prints them to the terminal, over the screen.
