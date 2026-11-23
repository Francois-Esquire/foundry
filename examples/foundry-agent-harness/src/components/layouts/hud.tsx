import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, type Ref, useCallback } from "react";
import { Arsenal } from "@/components/blocks/arsenal";
import { Conversation } from "@/components/blocks/conversation";
import { GoalBar } from "@/components/blocks/goal-bar";
import { HintBar } from "@/components/blocks/hint-bar";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { PortraitBay } from "@/components/blocks/portrait-bay";
import { Results, resultsMeta } from "@/components/blocks/results";
import { Steps } from "@/components/blocks/steps";
import { totalsLine, Vitals } from "@/components/blocks/vitals";
import { Weapon } from "@/components/blocks/weapon";
import type { Progress } from "@/game/progress";
import type { Scorecard } from "@/game/scorecard";
import { type Context, slotsOf } from "@/model/context";
import { occupancyOf } from "@/model/occupancy";
import { hud } from "@/model/palette";
import { quipFor } from "@/model/quip";
import { focusOn, type Rail, type RailStop } from "@/model/rail";
import type { Clock, Size } from "@/model/screen";
import type { PortraitSize } from "@/model/sprite";
import {
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
const WEAPON = 5;
const LOADOUT_MIN = 4;
const ARSENAL = 6;
const PAGE_OVERLAP = 3;
const PLATE_CHROME = 4;
const RESULTS = 6;
const CONVERSATION_MIN = 9;
const NAME = "FOUNDRY AGENT HARNESS";

export type RailSection = "arsenal" | "loadout" | "vitals" | "weapon";

export function hudGeometry({ height, width }: Size, judged = false) {
  const rail = width >= RAIL_WIDTH + GAP + MAIN_MIN;
  const body = height - HINTS;
  const main = width - (rail ? RAIL_WIDTH + GAP : 0);
  const everything = PORTRAIT.large + VITALS + WEAPON + LOADOUT_MIN + ARSENAL;
  const portrait: PortraitSize = body >= everything ? "large" : "small";
  const sections: RailSection[] = [];
  let left = body - PORTRAIT[portrait];
  for (const [section, rows] of [
    ["vitals", VITALS],
    ["weapon", WEAPON],
    ["loadout", LOADOUT_MIN],
    ["arsenal", ARSENAL],
  ] as const) {
    if (left >= rows) {
      sections.push(section);
      left -= rows;
    }
  }
  const stops: RailStop[] = rail
    ? [
        "avatar",
        ...(sections.includes("weapon") ? (["model", "effort"] as const) : []),
        ...(sections.includes("loadout") ? (["slot"] as const) : []),
      ]
    : [];
  const results = judged && body - STEPS - GOAL - RESULTS >= CONVERSATION_MIN;
  return {
    main,
    page: body - STEPS - GOAL - FRAME - PAGE_OVERLAP - (results ? RESULTS : 0),
    portrait,
    rail,
    results,
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

function keysFor(focus: RailStop | null, judging: boolean) {
  const turn = {
    avatar: "Avatar",
    effort: "Ammo",
    model: "Gun",
    slot: "Loadout",
  } as const;
  return [
    ...(judging
      ? ([
          ["A", "Accept"],
          ["R", "Reject"],
          ["Esc", "Skip"],
        ] as const)
      : []),
    ...(judging ? [] : ([["↵", "Run"]] as const)),
    ...(focus
      ? ([
          ["Tab", "Next"],
          ["↑/↓", turn[focus]],
        ] as const)
      : []),
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
  const focus = geometry.rail ? focusOn(rail, geometry.stops) : null;
  const reviewing = results?.verdict === null && draft === "";
  const steps = stepsOf(thread);
  const todos = todosOf(thread);
  const { health, left, used } = occupancyOf(steps, context.limit);
  const slots = slotsOf(context);
  const tallies = toolTallies(steps);
  const shows = (section: RailSection) => geometry.sections.includes(section);
  const tone = (stop: RailStop, ...more: RailStop[]) =>
    focus !== null && [stop, ...more].includes(focus) ? hud.amber : hud.bronze;
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
            <Plate
              icon="☻"
              meta={health}
              title={avatar.toUpperCase()}
              tone={tone("avatar")}
            >
              <PortraitBay
                focused={focus === "avatar"}
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
            {shows("weapon") ? (
              <Plate
                icon="⌖"
                meta={context.provider}
                title="WEAPON"
                tone={tone("model", "effort")}
              >
                <Weapon
                  effort={rail.effort}
                  focus={focus === "model" || focus === "effort" ? focus : null}
                  model={rail.model}
                  models={context.models}
                />
              </Plate>
            ) : null}
            {shows("loadout") ? (
              <Plate
                grow
                icon="◧"
                meta={`${slots.length} equipped`}
                title="LOADOUT"
                tone={tone("slot")}
              >
                <Loadout
                  focused={focus === "slot"}
                  selected={rail.slot}
                  slots={slots}
                />
              </Plate>
            ) : null}
            {shows("arsenal") ? (
              <box flexShrink={0} height={ARSENAL}>
                <Plate
                  grow
                  icon="⚒"
                  meta={`${tallies.reduce((sum, tally) => sum + tally.count, 0)} calls`}
                  title="ARSENAL"
                >
                  <Arsenal frame={clock.frame} tallies={tallies} />
                </Plate>
              </box>
            ) : null}
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
            <box flexShrink={0} height={RESULTS}>
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
            />
          </Plate>
        </box>
      </box>
      <HintBar keys={keysFor(focus, reviewing)} notes={thread.notes} />
    </box>
  );
}
