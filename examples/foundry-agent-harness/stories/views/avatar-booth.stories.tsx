import { defineStories, story } from "textbook-sh";
import { AvatarBoothView } from "@/views/avatar-booth";
import { renderFrame } from "../frame";

export default defineStories({
  component: "AvatarBoothView",
  description:
    "The avatars, animating. Arrow keys pick an avatar and its health; Space lands a hit.",
  title: "Views/Avatar booth",
});

export const Live = story({
  description: "Every avatar idling on the view's clock.",
  name: "Live",
  render: (renderer) =>
    renderFrame(renderer, <AvatarBoothView />, {
      height: 26,
      padded: false,
      width: 112,
    }),
});
