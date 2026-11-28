import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, type Ref, useCallback } from "react";
import { Conversation } from "@/components/blocks/conversation";
import { GoalBar } from "@/components/blocks/goal-bar";
import { HintBar } from "@/components/blocks/hint-bar";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { PortraitBay } from "@/components/blocks/portrait-bay";
import { RailRow } from "@/components/blocks/rail-row";
import { Results, resultsMeta } from "@/components/blocks/results";
import { Steps } from "@/components/blocks/steps";
import { ToolCalls } from "@/components/blocks/tool-calls";
import { Toolkit } from "@/components/blocks/toolkit";
import { totalsLine, Vitals } from "@/components/blocks/vitals";
import type { Progress } from "@/game/progress";
import type { Scorecard } from "@/game/scorecard";
import { type Context, slotsOf } from "@/model/context";
import { occupancyOf } from "@/model/occupancy";
import { hud } from "@/model/palette";
import { quipFor } from "@/model/quip";
import { focusOn, type Rail, type RailStop } from "@/model/rail";
import type { Clock, Size } from "@/model/screen";
import {
  compactCount,
  finishedTodos,
  isBusy,
  stepsOf,
  type Thread,
  threadTokens,
  titleOf,
  todosOf,
  toolTallies,
} from "@/model/thread";

const RAIL_WIDTH = 36;
const GAP = 1;
const MAIN_MIN = 40;
const HINTS = 1;
const FRAME = 3;
const STEPS = FRAME;
const GOAL = FRAME;
const PORTRAIT = { large: 20, small: 11 } as const;
const VITALS = 6;
const LOADOUT = 5;
const TOOLKIT_MIN = 4;
const CALLS = 6;
const ROW = 1;
const PAGE_OVERLAP = 3;
const PLATE_CHROME = 4;
const RESULTS = { roomy: 6, tight: 7 } as const;
const RESULTS_ROOMY = 56;
const CONVERSATION_MIN = 9;
const NAME = "FOUNDRY AGENT HARNESS";

export type RailSection = "calls" | "loadout" | "toolkit" | "vitals";

export function hudGeometry({ height, width }: Size, judged = false) {
  const rail = width >= RAIL_WIDTH + GAP + MAIN_MIN;
  const body = height - HINTS;
  const main = width - (rail ? RAIL_WIDTH + GAP : 0);
  const cards = [
    ["vitals", VITALS],
    ["loadout", LOADOUT],
    ["toolkit", TOOLKIT_MIN],
    ["calls", CALLS],
  ] as const;
  const everything =
    PORTRAIT.large + cards.reduce((sum, [, needs]) => sum + needs, 0);
  const portrait: keyof typeof PORTRAIT =
    body >= everything ? "large" : "small";
  const listed = cards.slice(0, Math.max(0, body - PORTRAIT[portrait]));
  let spare = body - PORTRAIT[portrait] - listed.length * ROW;
  const sections: RailSection[] = [];
  for (const [section, needs] of listed) {
    if (spare < needs - ROW) {
      break;
    }
    sections.push(section);
    spare -= needs - ROW;
  }
  const rows = listed
    .map(([section]) => section)
    .filter((section) => !sections.includes(section));
  const stops: RailStop[] =
    rail && sections.includes("toolkit") ? ["slot"] : [];
  const card = main < RESULTS_ROOMY ? RESULTS.tight : RESULTS.roomy;
  const results = judged && body - STEPS - GOAL - card >= CONVERSATION_MIN;
  return {
    main,
    page: body - STEPS - GOAL - FRAME - PAGE_OVERLAP - (results ? card : 0),
    portrait,
    rail,
    results,
    resultsRows: card,
    rows,
    sections,
    stepsWidth: main - PLATE_CHROME,
    stops,
  };
}

function shortened(text: string, room: number): string | undefined {
  if (room < 4) {
    return undefined;
  }
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

function keysFor(browsing: boolean, judging: boolean) {
  return [
    ...(judging
      ? ([
          ["A", "Accept"],
          ["R", "Reject"],
          ["Esc", "Skip"],
        ] as const)
      : []),
    ...(judging ? [] : ([["↵", "Run"]] as const)),
    ...(browsing ? ([["↑/↓", "Tools"]] as const) : []),
    ...(judging ? [] : ([["PgUp/PgDn", "Scroll"]] as const)),
    ["^C", "Quit"],
  ] as const;
}

export function HudLayout({
  avatar,
  clock,
  context,
  draft,
  onDraft,
  onResize,
  onSubmit,
  portrait,
  progress,
  rail,
  results = null,
  scrollRef,
  size,
  thread,
}: {
  readonly avatar: string;
  readonly clock: Clock;
  readonly context: Context;
  readonly draft: string;
  readonly onDraft: (draft: string) => void;
  readonly onResize: (size: Size) => void;
  readonly onSubmit: () => void;
  readonly portrait: ReactNode;
  readonly progress: Progress;
  readonly rail: Rail;
  readonly results?: Scorecard | null;
  readonly scrollRef?: Ref<ScrollBoxRenderable>;
  readonly size: Size;
  readonly thread: Thread;
}) {
  const geometry = hudGeometry(size, results !== null);
  const focus =
    geometry.stops.length > 0 ? focusOn(rail, geometry.stops) : null;
  const reviewing = results?.verdict === null && draft === "";
  const steps = stepsOf(thread);
  const todos = todosOf(thread);
  const { health, left, used } = occupancyOf(steps, context.limit);
  const slots = slotsOf(context);
  const tallies = toolTallies(steps);
  const shows = (section: RailSection) => geometry.sections.includes(section);
  const calls = tallies.reduce((sum, tally) => sum + tally.count, 0);
  const folded = {
    calls: { icon: "⚒", title: "TOOL CALLS", value: `${calls} total` },
    loadout: {
      icon: "⌖",
      title: "LOADOUT",
      value: `${rail.model} · ${rail.effort}`,
    },
    toolkit: { icon: "◧", title: "TOOLS", value: `${slots.length} equipped` },
    vitals: {
      icon: "♥",
      title: "VITALS",
      value: `${compactCount(left)} left · LV ${progress.level}`,
    },
  } as const;
  const measure = useCallback(
    function measureHud(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box
      backgroundColor={hud.ink}
      flexDirection="column"
      height="100%"
      onSizeChange={measure}
      width="100%"
    >
      <box flexDirection="row" flexGrow={1} flexShrink={1} gap={GAP}>
        {geometry.rail ? (
          <box flexDirection="column" flexShrink={0} width={RAIL_WIDTH}>
            <Plate icon="☻" meta={health} title={avatar.toUpperCase()}>
              <PortraitBay
                focused={false}
                portrait={portrait}
                quip={quipFor(thread, health)}
                size={geometry.portrait}
              />
            </Plate>
            {shows("vitals") ? (
              <Plate
                icon="♥"
                meta={totalsLine(threadTokens(thread))}
                title="VITALS"
              >
                <Vitals
                  health={health}
                  limit={context.limit}
                  progress={progress}
                  tokens={left}
                  used={used}
                />
              </Plate>
            ) : null}
            {shows("loadout") ? (
              <Plate icon="⌖" meta={context.provider} title="LOADOUT">
                <Loadout
                  effort={rail.effort}
                  focus={null}
                  locked
                  model={rail.model}
                  models={context.models}
                />
              </Plate>
            ) : null}
            {shows("toolkit") ? (
              <box
                flexDirection="column"
                flexShrink={1}
                minHeight={TOOLKIT_MIN}
              >
                <Plate
                  grow
                  icon="◧"
                  meta={`${slots.length} equipped`}
                  title="TOOLS"
                  tone={focus === "slot" ? hud.amber : hud.bronze}
                >
                  <Toolkit
                    focused={focus === "slot"}
                    selected={rail.slot}
                    slots={slots}
                  />
                </Plate>
              </box>
            ) : null}
            {shows("calls") ? (
              <box
                flexDirection="column"
                flexGrow={1}
                flexShrink={0}
                minHeight={CALLS}
              >
                <Plate grow icon="⚒" meta={`${calls} total`} title="TOOL CALLS">
                  <ToolCalls frame={clock.frame} tallies={tallies} />
                </Plate>
              </box>
            ) : null}
            {geometry.rows.map((section) => (
              <RailRow key={section} {...folded[section]} />
            ))}
          </box>
        ) : null}
        <box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Plate>
            <Steps
              frame={clock.frame}
              planning={thread.phase === "planning"}
              todos={todos}
              width={geometry.stepsWidth}
            />
          </Plate>
          <Plate
            grow
            meta={shortened(
              `${finishedTodos(todos)}/${todos.length} · ${titleOf(thread)}`,
              geometry.main - NAME.length - 12
            )}
            title={NAME}
          >
            <scrollbox
              contentOptions={{ paddingRight: 1 }}
              flexGrow={1}
              ref={scrollRef}
              stickyScroll
              stickyStart="bottom"
            >
              <Conversation clock={clock} encounters={thread.encounters} />
            </scrollbox>
          </Plate>
          {results && geometry.results ? (
            <box flexShrink={0} height={geometry.resultsRows}>
              <Plate
                grow
                icon="★"
                meta={resultsMeta(results)}
                title="RESULTS"
                tone={results.verdict === null ? hud.amber : hud.bronze}
              >
                <Results scorecard={results} />
              </Plate>
            </box>
          ) : null}
          <Plate tone={hud.amber}>
            <GoalBar
              busy={isBusy(thread)}
              draft={draft}
              frame={clock.frame}
              onDraft={onDraft}
              onSubmit={onSubmit}
              reviewing={reviewing}
              width={geometry.stepsWidth}
            />
          </Plate>
        </box>
      </box>
      <HintBar
        keys={keysFor(focus === "slot", reviewing)}
        notes={thread.notes}
        width={size.width}
      />
    </box>
  );
}
