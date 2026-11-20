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
| [`src/model`](./src/model) | The data the screen draws: a `Thread` and its `Context`. Types and two small readers, no Marbles. |
| [`src/views/harness.tsx`](./src/views/harness.tsx) | The screen, in [OpenTUI](https://github.com/anomalyco/opentui) React. It draws a `Thread` and a `Context` and reports a goal. |
| [`src/components/blocks`](./src/components/blocks) | The parts of the screen: the side panel and its four lists, the conversation, the goal bar. |
| [`src/app.tsx`](./src/app.tsx) | Holds the current thread and hands goals to the harness. |
| [`src/main.tsx`](./src/main.tsx) | The renderer, and the engine's disposal when it closes. |
| [`stories`](./stories) | Textbook stories for each block and the screen, and the sample threads they share with the tests. |
| [`test`](./test) | The screen rendered from the sample threads, and every story rendered once. |
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

## The screen on its own

Nothing under `src/model`, `src/views`, or `src/components` imports
`harness.ts`, so the screen renders without an engine, a model, or a signed-in
CLI. `HarnessView` takes a thread, a context, and an `onGoal` callback, and
sizes itself to the box it is mounted in. Below 72 columns the side panel is
dropped and the conversation takes the full width.

The screen is developed with [Textbook](https://textbook.sh) stories:

```sh
bun run stories
bun run stories:web
```

`stories` opens the story browser in the terminal; `stories:web` serves it in
a browser. Story files mirror the source they show: `stories/blocks/` follows
`src/components/blocks/` and `stories/views/` follows `src/views/`. Each state
is its own story, drawn from the sample threads in
[`stories/fixtures/threads.ts`](./stories/fixtures/threads.ts). No story
starts an agent turn.

```sh
bun run test
```

The tests render the screen from the same samples, and
`test/stories-render.test.ts` renders every story once, so a story that
throws, draws nothing, or leaves a key listener behind fails.

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
  told otherwise. `tool-call.tsx` also shows its timer in seconds, and its
  spinner only ticks while the call is running.
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
