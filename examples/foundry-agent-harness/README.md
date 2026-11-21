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

Run the build from the repository root. Type a goal and press Enter. PgUp
and PgDn scroll the conversation, and Ctrl+C quits. A second goal continues
the same conversation and adds to the list.

The screen is laid out like a game HUD. A status rail on the left shows an
avatar whose face follows the worker's context window, the vitals, the
weapon, the loadout, and the arsenal of tools used so far. Tab moves the
focus down the rail, and Up and Down change what it is on:

| Stop | Up and Down |
| --- | --- |
| Avatar | Pick the Smith, the Welder, or the Automaton. |
| Gun | Pick the model: `sonnet`, `opus`, or `haiku`. |
| Ammo | Load or drop a round of effort: low, medium, or high. |
| Loadout | Read what each skill and MCP server is for. |

The gun and ammo apply to the next goal. Each pairing gets its own engine
and worker session, so switching starts that pairing's conversation fresh.

The avatar is a real image where the terminal can draw one (the Kitty
graphics protocol or Sixel, as in Ghostty, Kitty, and WezTerm) and coloured
blocks elsewhere. Its health is an estimate: the last turn's input tokens
divided by its model steps, plus its output, against a 200,000-token window.

The harness needs an installed and signed-in Claude Code CLI, and each goal
spends a few real turns. The worker is your own Claude Code: it runs on the
host with your tools, in the directory you start it from.

## What it uses

| File | Holds |
| --- | --- |
| [`src/harness.ts`](./src/harness.ts) | The harness: one thread, its context, and every Marbles call. |
| [`src/backlog.ts`](./src/backlog.ts) | An MCP server in this process that lets the worker add a to-do. |
| [`src/model`](./src/model) | The data the screen draws: a `Thread`, its `Context`, the rail's state, the avatars and how a portrait is painted, a screen `Size`, and an animation `Clock`. Types and pure functions, no Marbles. |
| [`src/views/harness.tsx`](./src/views/harness.tsx) | `HarnessView`, the stateful screen. It takes a context and a `run`, calls the hooks, and fills the layout. `LivePortrait` beside it animates the avatar on its own clock. |
| [`src/hooks`](./src/hooks) | The screen's state: the thread, the goal draft, the rail, the portrait's picture and wounds, scrolling, the measured size, and the animation clock. |
| [`src/components/layouts/hud.tsx`](./src/components/layouts/hud.tsx) | The whole screen as a function of its props, and the geometry it is laid out with. |
| [`src/components/blocks`](./src/components/blocks) | The parts of the screen: the rail's cards, the portrait, the steps, the conversation, the goal bar, and the hint bar. |
| [`src/main.tsx`](./src/main.tsx) | The renderer, `HarnessView`, and the engine's disposal when it closes. |
| [`stories`](./stories) | Textbook stories for each block, the layout, and the view, and the sample threads they share with the tests. |
| [`test`](./test) | The layout rendered from the sample threads, the view driven by keys, the hooks, the import and state rules, and every story rendered once. |
| [`.claude/skills`](./.claude/skills) | The skills the worker gets. |
| [`art`](./art), [`scripts/sprites.ts`](./scripts/sprites.ts) | The avatars' source strips, and `bun run sprites`, which turns them into the atlases under `src/assets/avatars`. |
| `src/components/ui`, `src/hooks/use-theme.ts`, `src/lib` | [TermCN](https://www.termcn.dev) components, copied in by the shadcn CLI. |

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
| Status rail | OpenTUI `box` cards and an OpenTUI `image` for the avatar. |
| Conversation | TermCN `ChatThread` and `ChatMessage` inside an OpenTUI `scrollbox`; tool calls are TermCN `ToolCall` rows and replies are OpenTUI `markdown`. |
| Goal | OpenTUI `input`. |

Marbles writes nothing to disk here. The engine keeps sessions and artifacts
in memory, a script without a host keeps `tasks` in memory, and all three end
with the process. Claude Code still keeps its own session history.

## Threads and their context

`harness.ts` keeps one `Thread` (its messages, to-dos, notes, and token
counts) and one `Context` (the models, skills, and MCP servers the worker
can have). The screen gets the context and a `run` function, and `run` shows it
each new `Thread`, so a second thread is another `Thread` value and a way to
choose between them.

## The screen on its own

Nothing under `src/model`, `src/hooks`, `src/views`, `src/components`, or
`stories` imports `harness.ts` or `backlog.ts`, so the screen renders without
an engine, a model, or a signed-in CLI.

The screen has three layers:

- Components under `src/components` (`ui`, `blocks`, `layouts`) are
  presentational: props and callbacks in, rendering out. They read the theme
  and may memoise a derived value, and hold no state, effects, key listeners,
  or timers. `ui` imports no blocks or layouts, and blocks import no layouts.
- Hooks under `src/hooks` hold the state, each with its own keys.
- `HarnessView` in `src/views/harness.tsx` calls them and passes their
  values to `HudLayout`. `LivePortrait` holds the avatar's clock, so the
  conversation does not redraw on every animation frame.

| Hook | Takes | Gives |
| --- | --- | --- |
| `useThread` | `run` | The current thread, and `start(goal, weapon)`, which calls `run` with a setter and the chosen model and effort. |
| `useGoalDraft` | Whether the thread is busy, and what to do with a goal | The draft, its setter, and `submit`, which trims the draft, ignores it when empty or busy, hands it over once, and clears it. |
| `useRail` | The context, the number of avatars, and the stops the rail shows | The focused stop and the chosen avatar, model, effort, and loadout slot. Tab and Shift+Tab move the focus; Up and Down change what it is on. |
| `usePortrait` | An avatar, its health, a seed, the frame, and when it was hit | The avatar's picture for that moment, repainted only when it changes. |
| `useWound` | The health and the frame | The frame a hit landed, set whenever health worsens, and `hit`. |
| `usePageScroll` | The page height | The scrollbox ref. PgUp and PgDn scroll it by a page. |
| `useViewport` | Nothing | The size of the box the screen is mounted in (the terminal until it is measured), and `measure`, which the layout calls when the box resizes. |
| `useAnimationClock` | Whether anything animates | `{ frame, now }`, ticking every 80 ms only while active. Spinners draw `frame`; a running tool's timer is `now` less its `startedAt`. |

The layout sizes itself to the box it is mounted in, not the terminal.
Below 77 columns the rail is dropped, Tab does nothing, and the
conversation takes the full width. Under 42 rows the portrait halves and the
rail gives up the arsenal, then the loadout. `test/components-imports.test.ts` fails if
a component uses state, effects, key listeners, timers, or module-level
`let`, or imports the harness, a view, a stateful hook, Marbles, evlog, or
Bun.

The screen is developed with [Textbook](https://textbook.sh) stories:

```sh
bun run stories
bun run stories:web
```

`stories` opens the story browser in the terminal; `stories:web` serves it in
a browser. Story files mirror the source they show: `stories/blocks/` follows
`src/components/blocks/`, `stories/layouts/` follows
`src/components/layouts/`, and `stories/views/` follows `src/views/`. Block
and layout stories are driven by props alone, one story per state, drawn from
the sample threads and the fixed clock in
[`stories/fixtures/threads.ts`](./stories/fixtures/threads.ts). The view
stories mount `HarnessView` with a `run` from
[`stories/fixtures/run.ts`](./stories/fixtures/run.ts) that replays sample
threads when a goal is entered. No story starts an agent turn.

```sh
bun run test
```

The tests render the layout from the same samples, drive `HarnessView` with
a fake `run` (typing, Enter, Tab, PgUp and PgDn, a narrow terminal, and its
own box), and test the hooks. `test/stories-render.test.ts` renders every
story once, so a story that throws, draws nothing, or leaves a key listener
behind fails.

## TermCN components

`components.json` registers the TermCN registry, so the shadcn CLI adds a
component by name:

```sh
bunx shadcn@latest add @termcn/opentui/panel
```

The CLI adds the newest `@opentui/react` to `package.json`; set it back to
the version the repository uses. The copies are yours to edit, and Biome and
Knip leave `src/components/ui`, `src/hooks/use-theme.ts`, and `src/lib` alone.
`Panel` and `ChatThread` are used as copied. The others are edited so they
hold no state, and their callers pass it in:

- `tabs.tsx`: controlled. `activeTab` is required; `defaultTab`,
  `onTabChange`, its own state, and its Tab key listener are gone, and
  `useTabCycle` handles the keys. Also the row fix (an OpenTUI box stacks its
  children unless told `flexDirection="row"`); it fills its parent; and it no
  longer writes a clear-screen sequence to the terminal.
- `chat-message.tsx`: `collapsed` is a controlled prop instead of a starting
  value, its Enter key listener is gone, and the streaming dots draw a
  `dotFrame` prop instead of running their own timer. Also the row fix.
- `tool-call.tsx`: `collapsed` replaces `defaultCollapsed` as a controlled
  prop, and its Enter key listener is gone. The spinner draws a `frame` prop
  and the timer shows an `elapsed` prop in seconds, instead of two timers of
  its own; the timer shows only while the call is running and `elapsed` is
  given. Also the row fix.

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
