import { defineStories, story } from "textbook-sh";
import { Portrait } from "@/components/blocks/portrait";
import { HudLayout, hudGeometry } from "@/components/layouts/hud";
import type { Progress } from "@/game/progress";
import type { Scorecard } from "@/game/scorecard";
import { portraitImage } from "@/hooks/use-portrait";
import { avatars } from "@/model/avatars";
import { occupancyOf } from "@/model/occupancy";
import { type Rail, startRail } from "@/model/rail";
import type { Size } from "@/model/screen";
import { stepsOf, type Thread } from "@/model/thread";
import {
  clock,
  context,
  progress,
  scorecards,
  threads,
} from "../fixtures/threads";
import { ignore, renderFrame } from "../frame";

const tall = { height: 44, width: 120 };
const wide = { height: 30, width: 120 };
const classic = { height: 24, width: 80 };
const narrow = { height: 24, width: 60 };

export default defineStories({
  component: "HudLayout",
  description:
    "The whole screen as a function of its props: a status rail on the left, the steps, conversation and goal on the right.",
  title: "Layouts/Hud",
});

function screen(
  name: string,
  description: string,
  thread: Thread,
  {
    draft = "",
    levels = progress.fresh,
    rail = {},
    results = null,
    size = tall,
  }: {
    readonly draft?: string;
    readonly levels?: Progress;
    readonly rail?: Partial<Rail>;
    readonly results?: Scorecard | null;
    readonly size?: Size;
  } = {}
) {
  const state = { ...startRail(context), ...rail };
  const avatar = avatars[state.avatar] ?? avatars[0];
  return story({
    description,
    name,
    render: async (renderer) => {
      const image = await portraitImage({
        avatar,
        frame: 0,
        health: occupancyOf(stepsOf(thread), context.limit).health,
        hurtAt: null,
        seed: 1,
      });
      return renderFrame(
        renderer,
        <HudLayout
          avatar={avatar.name}
          clock={clock}
          context={context}
          draft={draft}
          onDraft={ignore}
          onResize={ignore}
          onSubmit={ignore}
          portrait={
            <Portrait image={image} size={hudGeometry(size).portrait} />
          }
          progress={levels}
          rail={state}
          results={results}
          size={size}
          thread={thread}
        />,
        { ...size, padded: false }
      );
    },
  });
}

export const Idle = screen("Idle", "Before any goal.", threads.idle);

export const Drafted = screen(
  "Drafted",
  "A goal typed and not yet handed over.",
  threads.idle,
  { draft: "List the source files here and say what each one is for." }
);

export const Planning = screen(
  "Planning",
  "The goal is being planned into to-dos.",
  threads.planning
);

export const Working = screen(
  "Working",
  "Mid-goal: one step done, one running, one added by the worker.",
  threads.working
);

export const Done = screen(
  "Done",
  "Every step finished and the notes kept, waiting for a verdict.",
  threads.done,
  { results: scorecards.pending }
);

export const Scored = screen(
  "Scored",
  "The encounter accepted: its rank, line items and XP, and a level gained.",
  threads.done,
  { levels: progress.seasoned, results: scorecards.accepted }
);

export const Rejected = screen(
  "Rejected",
  "The encounter rejected, so nothing was banked.",
  threads.done,
  { results: scorecards.rejected }
);

export const Failed = screen(
  "Failed",
  "A turn failed and the harness stopped.",
  threads.failed
);

export const Toolkit = screen(
  "Toolkit focused",
  "The toolkit is the rail's one stop; the chosen slot explains itself.",
  threads.working,
  { rail: { focus: "slot" } }
);

export const Swapped = screen(
  "Heavy picks",
  "A mission started with another avatar, a bigger model and high effort.",
  threads.working,
  { rail: { avatar: 2, effort: "high", model: "opus" } }
);

export const Wide = screen(
  "Wide and short",
  "At 120 by 30 the portrait shrinks and the tool calls collapse to a row.",
  threads.working,
  { size: wide }
);

export const Classic = screen(
  "80 by 24",
  "The rail keeps the portrait, vitals and loadout.",
  threads.working,
  { size: classic }
);

export const Narrow = screen(
  "Narrow",
  "Too narrow for the rail; the conversation keeps the screen.",
  threads.done,
  { size: narrow }
);
