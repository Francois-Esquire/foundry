import { defineStories, story } from "textbook-sh";
import { Portrait } from "@/components/blocks/portrait";
import { portraitImage } from "@/hooks/use-portrait";
import { type Avatar, avatars } from "@/model/avatars";
import { HEALTH } from "@/model/sprite";
import { renderFrame } from "../frame";

const HIT_AT = 100;
const sheet = { height: 18, width: 170 };
const strip = { height: 18, width: 104 };

export default defineStories({
  component: "Portrait",
  description:
    "An avatar as an image: true pixels where the terminal draws them, blocks elsewhere. The avatar, its health, a seed and the clock's frame pick the picture.",
  title: "Blocks/Portrait",
});

function ladder(avatar: Avatar) {
  return story({
    description: `${avatar.name} from fresh to critical, at rest.`,
    name: avatar.name,
    render: async (renderer) => {
      const images = await Promise.all(
        HEALTH.map((health) =>
          portraitImage({ avatar, frame: 0, health, hurtAt: null, seed: 1 })
        )
      );
      return renderFrame(
        renderer,
        <box flexDirection="row" gap={1}>
          {images.map((image, index) => (
            <Portrait image={image} key={HEALTH[index]} />
          ))}
        </box>,
        sheet
      );
    },
  });
}

function lineup(name: string, description: string, frame: number) {
  return story({
    description,
    name,
    render: async (renderer) => {
      const images = await Promise.all(
        avatars.map((avatar, index) =>
          portraitImage({
            avatar,
            frame,
            health: "hurt",
            hurtAt: HIT_AT,
            seed: index + 1,
          })
        )
      );
      return renderFrame(
        renderer,
        <box flexDirection="row" gap={2}>
          {images.map((image, index) => (
            <Portrait image={image} key={avatars[index]?.name} />
          ))}
        </box>,
        strip
      );
    },
  });
}

const [smith, welder, automaton] = avatars;

export const Smith = ladder(smith);

export const Welder = ladder(welder);

export const Automaton = ladder(automaton);

export const Loading = story({
  description: "Before the picture has loaded.",
  name: "Loading",
  render: (renderer) => renderFrame(renderer, <Portrait image={null} />, strip),
});

export const Struck = lineup(
  "Struck",
  "The frame a hit lands: every avatar flashes and shakes.",
  HIT_AT
);

export const Reeling = lineup(
  "Reeling",
  "Three frames after a hit: winces, blood and sparks.",
  HIT_AT + 3
);
