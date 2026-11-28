import { defineStories, story } from "textbook-sh";
import { AppView } from "@/views/app";
import { BriefingView } from "@/views/briefing";
import { replay } from "../fixtures/run";
import { context, threads } from "../fixtures/threads";
import { ignore, renderFrame } from "../frame";

const tall = { height: 44, padded: false, width: 120 };

export default defineStories({
  component: "BriefingView",
  description:
    "The Get Started menu. Tab moves between the character, the model and the effort; Up and Down change the one in focus; Enter starts the mission.",
  title: "Views/Briefing",
});

export const Menu = story({
  description: "Every character animating, with the loadout and the tools.",
  name: "Menu",
  render: (renderer) =>
    renderFrame(
      renderer,
      <BriefingView context={context} onStart={ignore} />,
      tall
    ),
});

export const Short = story({
  description: "A short screen halves the portraits.",
  name: "Short",
  render: (renderer) =>
    renderFrame(renderer, <BriefingView context={context} onStart={ignore} />, {
      height: 24,
      padded: false,
      width: 80,
    }),
});

export const Narrow = story({
  description: "A narrow screen shows only the chosen character.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <BriefingView context={context} onStart={ignore} />, {
      height: 30,
      padded: false,
      width: 60,
    }),
});

export const Mission = story({
  description:
    "The whole app: pick on the menu, press Enter, then type a goal to replay a sample thread.",
  name: "Menu into mission",
  render: (renderer) =>
    renderFrame(
      renderer,
      <AppView
        context={context}
        run={replay([threads.planning, threads.working, threads.done])}
      />,
      tall
    ),
});
