import { defineStories, story } from "textbook-sh";
import { Portrait } from "@/components/blocks/portrait";
import { type Avatar, avatars } from "@/model/avatars";
import { HEALTH } from "@/model/sprite";
import { renderFrame } from "../frame";

const HIT_AT = 100;
const sheet = { height: 18, width: 170 };
const strip = { height: 18, width: 104 };

export default defineStories({
  component: "Portrait",
  description:
    "An avatar drawn in half blocks. The avatar, its health, a seed and the clock's frame pick every pixel.",
  title: "Blocks/Portrait",
});

function Ladder({
  avatar,
  frame = 0,
  hurtAt = null,
}: {
  readonly avatar: Avatar;
  readonly frame?: number;
  readonly hurtAt?: number | null;
}) {
  return (
    <box flexDirection="row" gap={1}>
      {HEALTH.map((health) => (
        <Portrait
          avatar={avatar}
          frame={frame}
          health={health}
          hurtAt={hurtAt}
          key={health}
          seed={1}
        />
      ))}
    </box>
  );
}

function Lineup({
  frame,
  hurtAt = null,
}: {
  readonly frame: number;
  readonly hurtAt?: number | null;
}) {
  return (
    <box flexDirection="row" gap={2}>
      {avatars.map((avatar, index) => (
        <Portrait
          avatar={avatar}
          frame={frame}
          health="hurt"
          hurtAt={hurtAt}
          key={avatar.name}
          seed={index + 1}
        />
      ))}
    </box>
  );
}

function ladder(avatar: Avatar) {
  return story({
    description: `${avatar.name} from fresh to critical, at rest.`,
    name: avatar.name,
    render: (renderer) =>
      renderFrame(renderer, <Ladder avatar={avatar} />, sheet),
  });
}

const [smith, welder, automaton] = avatars;

export const Smith = ladder(smith);

export const Welder = ladder(welder);

export const Automaton = ladder(automaton);

export const Struck = story({
  description: "The frame a hit lands: every avatar flashes and shakes.",
  name: "Struck",
  render: (renderer) =>
    renderFrame(renderer, <Lineup frame={HIT_AT} hurtAt={HIT_AT} />, strip),
});

export const Reeling = story({
  description: "Three frames after a hit: winces, blood and sparks.",
  name: "Reeling",
  render: (renderer) =>
    renderFrame(renderer, <Lineup frame={HIT_AT + 3} hurtAt={HIT_AT} />, strip),
});
