import { defineStories, story } from "textbook-sh";
import { Portrait } from "@/components/blocks/portrait";
import { HudLayout, hudGeometry } from "@/components/layouts/hud";
import { portraitImage } from "@/hooks/use-portrait";
import { avatars } from "@/model/avatars";
import { type Rail, startRail } from "@/model/rail";
import type { Size } from "@/model/screen";
import { healthAt } from "@/model/sprite";
import { contextUsed, type Thread } from "@/model/thread";
import { clock, context, threads } from "../fixtures/threads";
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
    rail = {},
    size = tall,
  }: {
    readonly draft?: string;
    readonly rail?: Partial<Rail>;
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
        health: healthAt(contextUsed(thread, context.limit)),
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
          rail={state}
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
  "Every step finished and the notes kept.",
  threads.done
);

export const Failed = screen(
  "Failed",
  "A turn failed and the harness stopped.",
  threads.failed
);

export const Loadout = screen(
  "Loadout focused",
  "Tab has reached the loadout; the chosen slot explains itself.",
  threads.working,
  { rail: { focus: "slot" } }
);

export const Rearmed = screen(
  "Rearmed",
  "Another avatar, a bigger gun and full ammo.",
  threads.working,
  { rail: { avatar: 2, effort: "high", focus: "effort", model: "opus" } }
);

export const Wide = screen(
  "Wide and short",
  "At 120 by 30 the portrait shrinks and the arsenal gives way.",
  threads.working,
  { size: wide }
);

export const Classic = screen(
  "80 by 24",
  "The rail keeps the portrait, vitals and weapon.",
  threads.working,
  { size: classic }
);

export const Narrow = screen(
  "Narrow",
  "Too narrow for the rail; the conversation keeps the screen.",
  threads.done,
  { size: narrow }
);
