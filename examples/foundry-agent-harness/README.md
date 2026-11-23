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

Run the build from the repository root. The harness opens on a Get Started
menu: Left and Right change the highlighted choice, Up and Down (or Tab) move
between the character, the model, and the effort, and Enter starts the mission.
Clicking a character picks it.

| Stop | Left and Right |
| --- | --- |
| Character | Pick one of nine: the Smith, Welder, Caster, Machinist, Rigger, Assayer, Stoker, Fitter, or the Automaton. The row shows as many as fit and slides to keep the choice in view. |
| Model | Pick the model: `sonnet`, `opus`, or `haiku`. |
| Effort | Raise or lower the effort: low, medium, or high. |

The menu centres itself and scales with the terminal: it shows every
character at the largest of four portrait sizes that fits, falls back to one
character at a time when the row does not fit, stacks the loadout and tools
on a narrow screen, and gives up the header and then the tools on a short
one. The menu also lists the tools: the skills and MCP servers the worker
carries. The character, model, and effort stay for the whole mission, so the
worker keeps one conversation and its context window is never reset by a
change of model. Quit and start again to pick differently.

On the mission screen, type a goal and press Enter. The first goal names the
mission. PgUp and PgDn scroll the conversation, and Ctrl+C quits. A second
goal continues the same conversation and adds to the list.

Each goal and everything done for it is an encounter. When one ends, a
results card above the goal bar shows what it took and takes the keys from
the goal field: A accepts the result, R rejects it, and Esc skips the verdict.
The card takes the keys only while the goal field is empty, so a goal typed ahead is never read as a verdict. Accepting banks XP toward the next level. A verdict cannot be changed, and a
skipped encounter stays unscored. The goal field takes the keys back once a
verdict is in.

The screen is laid out like a game HUD. A status rail on the left shows an
avatar whose face follows the worker's context window, the vitals (the
window left, the tokens spent, and your level and XP), the loadout, the
tools, and the arsenal of tools used so far. The loadout is locked for the
mission; Up and Down move through the tools to read what each skill and
MCP server is for.

The avatar is a real image where the terminal can draw one (the Kitty
graphics protocol or Sixel, as in Ghostty, Kitty, and WezTerm) and coloured
blocks elsewhere. Its health follows occupancy, an estimate of the share of
the window in use: the last step's input tokens divided by its model calls,
plus its output, against a 200,000-token window.

The harness needs an installed and signed-in Claude Code CLI, and each goal
spends a few real turns. The worker is your own Claude Code: it runs on the
host with your tools, in the directory you start it from.

## What it uses

| File | Holds |
| --- | --- |
| [`src/harness.ts`](./src/harness.ts) | The harness: one thread, its context, and every Marbles call. |
| [`src/backlog.ts`](./src/backlog.ts) | An MCP server in this process that lets the worker add a to-do. |
| [`src/model`](./src/model) | The data the screen draws: a `Thread` and its encounters, its `Context`, occupancy and health, the rail's state, the avatars and how a portrait is painted, a screen `Size`, and an animation `Clock`. Types and pure functions, no Marbles. |
| [`src/game`](./src/game) | The game: an encounter's facts, the rules that turn facts and a verdict into XP, the scorecard, and the session's progress. Pure functions of records. |
| [`src/views/harness.tsx`](./src/views/harness.tsx) | `HarnessView`, the stateful screen. It takes a context and a `run`, calls the hooks, and fills the layout. `LivePortrait` beside it animates the avatar on its own clock. |
| [`src/hooks`](./src/hooks) | The screen's state: the thread, the verdicts, the goal draft, the rail, the portrait's picture and wounds, scrolling, the measured size, and the animation clock. |
| [`src/components/layouts/hud.tsx`](./src/components/layouts/hud.tsx) | The whole screen as a function of its props, and the geometry it is laid out with. |
| [`src/components/blocks`](./src/components/blocks) | The parts of the screen: the rail's cards, the portrait, the steps, the conversation, the results card, the goal bar, and the hint bar. |
| [`src/main.tsx`](./src/main.tsx) | The renderer, `HarnessView`, and the engine's disposal when it closes. |
| [`stories`](./stories) | Textbook stories for each block, the layout, and the view, and the sample threads they share with the tests. |
| [`test`](./test) | The layout rendered from the sample threads, the view driven by keys, the hooks, the model, occupancy and the game's rules, the import and state rules, and every story rendered once. |
| [`.claude/skills`](./.claude/skills) | The skills the worker gets. |
| [`art`](./art), [`scripts/sprites.ts`](./scripts/sprites.ts) | The avatars' source strips, and `bun run sprites`, which turns them into the atlases under `src/assets/avatars`. Eye poses (blink and the glances) keep only the top of the face and mouth poses (the smirk) only the bottom, so the two layers combine freely: the Smith rests on a smirk, smiles now and then, and blinks or glances with either. |
| `src/components/ui`, `src/hooks/use-theme.ts`, `src/lib` | [TermCN](https://www.termcn.dev) components, copied in by the shadcn CLI. |

| Piece | From Marbles |
| --- | --- |
| The host | `Engine` from `@foundry.sh/marbles/lib`, built from in-memory session and artifact stores and a `ModelManager` holding the Claude Code provider. |
| The planner | `agent` with a structured `Output`, so the plan comes back as a typed list instead of text to parse. |
| The to-do list | `tasks`: each planned task depends on the one before it, and the loop takes whatever `tasks.ready()` offers next. |
| The worker | One `engine.agents.session` for every task. Its `onText`, `onToolCall`, and `onToolResult` handlers feed the screen as the step runs. |
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

`harness.ts` keeps one `Thread` and one `Context` (the models, skills, and
MCP servers the worker can have). The screen gets the context and a `run`
function, and `run` shows it each new `Thread`, so a second thread is another
`Thread` value and a way to choose between them.

A `Thread` is its phase, its notes, and a list of encounters. Each
`Encounter` holds:

| Field | Holds |
| --- | --- |
| `id` | Minted by the harness, so a verdict stays with its encounter. |
| `goal`, `loadout` | The text submitted and the model and effort it ran with. |
| `startedAt`, `endedAt` | When it started and ended, from the harness's clock; `endedAt` is `null` while it runs. |
| `outcome` | `running`, `finished`, or `failed`, with `error` saying why it failed. |
| `plan` | The planner's own input and output tokens. |
| `todos` | The to-dos planned or added during it. |
| `steps` | Each to-do worked: its reply, tool calls, and its own token `usage`. |

Totals are derived, not kept alongside. The title is the first goal, an encounter's tokens
are its plan plus its steps, the thread's totals are the sum of its
encounters, and the conversation draws each goal and failure from the
encounter. `occupancyOf` in `src/model/occupancy.ts` turns the latest step's
usage into the estimated tokens in use, the share of the window, the tokens
left, and the health; the rail, the portrait, and the game all call it.

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
| `useThread` | `run` | The current thread, and `start(goal, loadout)`, which calls `run` with a setter and the chosen model and effort. |
| `useVerdicts` | The latest encounter | The verdicts given so far, by encounter id. A accepts, R rejects and Esc skips, only once the latest encounter has ended and has none. |
| `useGoalDraft` | Whether the thread is busy, and what to do with a goal | The draft, its setter, and `submit`, which trims the draft, ignores it when empty or busy, hands it over once, and clears it. |
| `useMission` | Nothing | The picks made on the menu (none until a mission starts), and `begin`, which starts one with them. |
| `useConfirm` | What to do | Calls it when Enter is pressed. |
| `useBriefing` | The context and the number of avatars | The menu's rail and `choose(avatar)`. Left and Right change the focused choice; Up, Down, and Tab move the focus. |
| `useRail` | The context, the number of avatars, the stops in play, and optionally where to start | The focused stop and the chosen avatar, model, effort, and tools slot. Tab and Shift+Tab move the focus; Up and Down change what it is on. The mission screen uses only the tools. |
| `usePortrait` | An avatar, its health, a seed, the frame, and when it was hit | The avatar's picture for that moment, repainted only when it changes. |
| `useWound` | The health and the frame | The frame a hit landed, set whenever health worsens, and `hit`. |
| `usePageScroll` | The page height | The scrollbox ref. PgUp and PgDn scroll it by a page. |
| `useViewport` | Nothing | The size of the box the screen is mounted in (the terminal until it is measured), and `measure`, which the layout calls when the box resizes. |
| `useAnimationClock` | Whether anything animates | `{ frame, now }`, ticking every 80 ms only while active. Spinners draw `frame`; a running tool's timer is `now` less its `startedAt`. |

The layout sizes itself to the box it is mounted in, not the terminal.
Below 77 columns the rail is dropped and the
conversation takes the full width. Under 42 rows the portrait halves and the
rail gives up the arsenal, then the tools. The results card takes six rows, or seven when the main column is under 56 columns wide,
from the conversation and is dropped under 22 rows (23 for the seven-row card); while a verdict is
pending the hint bar shows its keys in place of the scroll keys. `test/components-imports.test.ts` fails if
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

## The game

`src/game` scores encounters. It imports only `src/model`, never Marbles,
React, OpenTUI, or the harness, and holds no state: it is a function of an
encounter record, a verdict, and the window size. The verdicts live in
`useVerdicts`, and `HarnessView` joins the two.

- `factsOf` reads what code measured about an encounter: steps finished and
  planned, tool calls and failed calls, tokens in and out, the share of the
  window left at its end, the loadout, how long it took, and its outcome.
- `lineItems` in `rules.ts` turns facts and a verdict into labelled, signed
  amounts. The rules are one table in that file.
- `scorecardOf` gives the facts, the verdict (`null` while pending), the line
  items, their total, and a rank once judged.
- `progressOf` folds the scorecards into the XP banked, the level, and the
  XP into and needed for the next level. Level `n` needs `100 × n` more XP.
  Nothing is saved to disk.

| Rule | XP |
| --- | --- |
| Accepted | +50 |
| Steps done | +10 for each finished step |
| Clean run | +25 when no tool call failed and the encounter did not fail |
| Light touch | +20 when at least 60% of the window is left, unless the encounter switched to a model and effort pairing not used before, which starts on an empty window |
| Lighter model | +30 for `haiku`, +15 for `sonnet`, 0 for `opus` or a model the rules do not know |
| Less effort | +20 for low effort, +10 for medium, 0 for high |
| Under par | +25 when the tokens spent are under 10,000 plus 20,000 per planned step |
| Failed run | Brings a failed encounter down to 10 XP |

Only an accepted encounter earns anything; a rejected or unjudged one banks
0. A total of 170 ranks S, 130 ranks A, 90 ranks B, and anything lower C.

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
