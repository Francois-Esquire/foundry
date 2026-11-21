import type { NativeImage } from "@opentui/core";
import type { ReactNode } from "react";
import { defineStories, story } from "textbook-sh";
import { Gauge } from "@/components/blocks/gauge";
import { Portrait } from "@/components/blocks/portrait";
import { HudLayout, type HudSection } from "@/components/layouts/hud";
import { portraitImage } from "@/hooks/use-portrait";
import { avatars } from "@/model/avatars";
import { BRACKETED, hud } from "@/model/palette";
import type { Size } from "@/model/screen";
import { ignore, renderFrame } from "../frame";

const wide = { height: 44, width: 120 };
const compact = { height: 30, width: 96 };

export default defineStories({
  component: "HudLayout",
  description:
    "A blockout of the next screen: a status rail of cards on the left, the steps, conversation and goal on the right.",
  title: "Layouts/Hud",
});

function Region({ children }: { readonly children: string }) {
  return <text fg={hud.dim}>{children}</text>;
}

const [smith] = avatars;

function Bay({ image }: { readonly image: NativeImage }) {
  return (
    <box flexDirection="column">
      <Portrait image={image} />
      <box
        backgroundColor={hud.tint}
        flexDirection="row"
        justifyContent="center"
      >
        <text fg={hud.bright}>❝ holding steady ❞</text>
      </box>
    </box>
  );
}

function Vital({
  label,
  level,
  tone,
  value,
}: {
  readonly label: string;
  readonly level: number;
  readonly tone: string;
  readonly value: string;
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={hud.text}>{label}</text>
        <box flexGrow={1} />
        <text fg={tone}>
          <b>{value}</b>
        </text>
      </box>
      <Gauge cells={30} level={level} tone={tone} />
    </box>
  );
}

function Vitals() {
  return (
    <box flexDirection="column">
      <Vital
        label="Context"
        level={0.71}
        tone={hud.amber}
        value="142k / 200k"
      />
      <Vital label="Stamina" level={0.64} tone={hud.red} value="64%" />
    </box>
  );
}

function Arsenal() {
  return (
    <box flexDirection="column">
      {[
        ["Bash", "6", 6],
        ["Read", "4", 4],
        ["Skill", "1", 1],
      ].map(([name, count, pips]) => (
        <box flexDirection="row" gap={1} key={name}>
          <text fg={hud.ok}>●</text>
          <text fg={hud.text}>{name}</text>
          <box flexGrow={1} />
          <text fg={hud.bronze}>{"▮".repeat(Number(pips))}</text>
          <text fg={hud.dim}>{`×${count}`}</text>
        </box>
      ))}
    </box>
  );
}

function Slot({
  index,
  kind,
  name,
  selected = false,
}: {
  readonly index: string;
  readonly kind?: string;
  readonly name?: string;
  readonly selected?: boolean;
}) {
  return (
    <box
      backgroundColor={selected ? hud.tint : undefined}
      flexDirection="row"
      gap={1}
    >
      <text fg={selected ? hud.amber : hud.faint}>{selected ? "▶" : " "}</text>
      <text fg={hud.bronze}>{index}</text>
      {name ? (
        <text fg={selected ? hud.bright : hud.text}>{name}</text>
      ) : (
        <text fg={hud.faint}>{"╌".repeat(14)}</text>
      )}
      <box flexGrow={1} />
      <text fg={hud.dim}>{kind ?? ""}</text>
    </box>
  );
}

function Loadout() {
  return (
    <box flexDirection="column">
      <Slot index="01" kind="skill" name="task-notes" selected />
      <Slot index="02" kind="mcp" name="backlog" />
      <Slot index="03" />
      <Slot index="04" />
    </box>
  );
}

function Steps() {
  return (
    <text wrapMode="none">
      <span bg={hud.okDeep} fg={hud.ok}>
        {" ✓ 1 Locate package.json "}
      </span>
      <span fg={hud.okDim}>{"━━"}</span>
      <span bg={hud.okDeep} fg={hud.ok}>
        {" ✓ 2 Identify scripts "}
      </span>
      <span fg={hud.amber}>{"━━"}</span>
      <span bg={hud.amber} fg={hud.ink}>
        <b>{" ▶ 3 Check setup "}</b>
      </span>
      <span fg={hud.faint}>{"╌╌"}</span>
      <span bg={hud.tint} fg={hud.dim}>
        {" 4 Summarize "}
      </span>
    </text>
  );
}

function Card({
  children,
  label,
  note,
  tone,
}: {
  readonly children: string;
  readonly label: string;
  readonly note?: string;
  readonly tone: string;
}) {
  return (
    <box
      border
      borderColor={tone}
      customBorderChars={BRACKETED}
      flexDirection="row"
      gap={2}
      paddingX={1}
    >
      <text fg={tone}>
        <b>{label}</b>
      </text>
      <text fg={hud.text}>{children}</text>
      <box flexGrow={1} />
      {note ? <text fg={hud.dim}>{note}</text> : null}
    </box>
  );
}

function Speaker({
  name,
  note,
}: {
  readonly name: string;
  readonly note?: string;
}) {
  return (
    <text wrapMode="none">
      <span bg={hud.tint} fg={hud.amber}>
        <b>{` ${name} `}</b>
      </span>
      {note ? <span fg={hud.dim}>{`  ${note}`}</span> : null}
    </text>
  );
}

function Talk() {
  return (
    <box flexDirection="column">
      <Speaker name="YOU" />
      <text fg={hud.text}>
        Read package.json here and explain how to run this example.
      </text>
      <text> </text>
      <Speaker name="AGENT" note="1 · Locate package.json" />
      <Card label="TOOL" note="0.4s" tone={hud.bronze}>
        Read package.json
      </Card>
      <Card label="RESULT" tone={hud.okDim}>
        Two scripts found: start and test.
      </Card>
      <text fg={hud.text}>This example starts with bun run start.</text>
      <text> </text>
      <Speaker name="AGENT" note="3 · Check setup" />
      <Card label="TOOL" note="1.2s" tone={hud.amber}>
        Bash bun run --help
      </Card>
    </box>
  );
}

function Goal() {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={hud.amber}>
        <b>{">_"}</b>
      </text>
      <text fg={hud.dim}>Message the agent…</text>
      <box flexGrow={1} />
      <text bg={hud.tint} fg={hud.amber}>
        {" ↵ "}
      </text>
    </box>
  );
}

function Hints() {
  return (
    <text fg={hud.dim} wrapMode="none">
      {[
        ["↵", "Send"],
        ["Tab", "Loadout"],
        ["a", "Avatar"],
        ["PgUp/PgDn", "Scroll"],
        ["^C", "Quit"],
      ].map(([key, action]) => (
        <span key={key}>
          <span bg={hud.tint} fg={hud.amber}>{` ${key} `}</span>
          {` ${action}   `}
        </span>
      ))}
    </text>
  );
}

function regions(): HudSection[] {
  return [
    { content: <Region>portrait and comment</Region>, key: "portrait" },
    {
      content: <Region>context · stamina</Region>,
      key: "vitals",
      title: "VITALS",
    },
    {
      content: <Region>tools used, once each</Region>,
      key: "arsenal",
      title: "ARSENAL",
    },
    {
      content: <Region>skills and MCP, selectable</Region>,
      grow: true,
      key: "loadout",
      title: "LOADOUT",
    },
  ];
}

async function sketch(): Promise<HudSection[]> {
  const image = await portraitImage({
    avatar: smith,
    frame: 0,
    health: "scuffed",
    hurtAt: null,
    seed: 1,
  });
  return [
    { content: <Bay image={image} />, key: "portrait" },
    {
      content: <Vitals />,
      icon: "♥",
      key: "vitals",
      meta: "160k tok",
      title: "VITALS",
    },
    {
      content: <Arsenal />,
      icon: "⚒",
      key: "arsenal",
      meta: "11 calls",
      title: "ARSENAL",
    },
    {
      content: <Loadout />,
      grow: true,
      icon: "◧",
      key: "loadout",
      meta: "2 / 4",
      title: "LOADOUT",
    },
  ];
}

function screen(sections: HudSection[], main: ReactNode, steps: ReactNode) {
  return (
    <HudLayout
      goal={<Goal />}
      hints={<Hints />}
      main={main}
      onResize={ignore}
      sections={sections}
      steps={steps}
    />
  );
}

function padless(size: Size) {
  return { ...size, padded: false };
}

export const Regions = story({
  description: "Every region labelled with what will go there.",
  name: "Regions",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(
        regions(),
        <Region>conversation</Region>,
        <Region>checkpoints, as steps</Region>
      ),
      padless(wide)
    ),
});

export const Sketch = story({
  description: "The regions filled with stand-in content, to judge the look.",
  name: "Sketch",
  render: async (renderer) =>
    renderFrame(
      renderer,
      screen(await sketch(), <Talk />, <Steps />),
      padless(wide)
    ),
});

export const Compact = story({
  description: "The same sketch at 96 by 30.",
  name: "Compact",
  render: async (renderer) =>
    renderFrame(
      renderer,
      screen(await sketch(), <Talk />, <Steps />),
      padless(compact)
    ),
});
