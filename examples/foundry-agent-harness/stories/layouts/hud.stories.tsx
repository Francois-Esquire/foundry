import type { ReactNode } from "react";
import { defineStories, story } from "textbook-sh";
import { Chip } from "@/components/blocks/chip";
import { PortraitBay } from "@/components/blocks/portrait-bay";
import { Slab } from "@/components/blocks/slab";
import { StatTile } from "@/components/blocks/stat-tile";
import { StepStrip } from "@/components/blocks/step-strip";
import { HudLayout, type HudSection } from "@/components/layouts/hud";
import { hudGeometry } from "@/model/hud-art";
import { hud, tones } from "@/model/palette";
import type { Detail } from "@/model/pixels";
import type { Size } from "@/model/screen";
import type { Step } from "@/model/steps";
import { ignore, renderFrame } from "../frame";

const wide = { height: 34, width: 120 };
const compact = { height: 30, width: 96 };
const small = { height: 24, width: 80 };
const TALL = 32;
const RAIL = 22;

const STEPS: readonly Step[] = [
  { label: "Locate package.json", state: "done" },
  { label: "Identify scripts", state: "done" },
  { label: "Check setup", state: "active" },
  { label: "Summarize", state: "pending" },
];

export default defineStories({
  component: "HudLayout",
  description:
    "A blockout of the next screen: a machined status rail on the left, the steps, conversation and goal on the right.",
  title: "Layouts/Hud",
});

function Region({ children }: { readonly children: string }) {
  return (
    <text bg={hud.screen} fg={hud.dim}>
      {children}
    </text>
  );
}

function Vitals({
  detail,
  gap,
}: {
  readonly detail: Detail;
  readonly gap: number;
}) {
  return (
    <box flexDirection="column" gap={gap}>
      <StatTile
        detail={detail}
        label="CONTEXT"
        level={0.71}
        note="of 200k"
        tone="amber"
        width={RAIL}
      />
      <StatTile
        detail={detail}
        label="STAMINA"
        level={0.64}
        note="holding"
        tone="red"
        width={RAIL}
      />
    </box>
  );
}

function Arsenal() {
  return (
    <box flexDirection="column">
      {[
        ["Bash", "6"],
        ["Read", "4"],
        ["Skill", "1"],
      ].map(([name, count]) => (
        <box flexDirection="row" key={name}>
          <text bg={tones.green.dim} fg={tones.green.glow}>
            ▀
          </text>
          <text bg={hud.screen} fg={hud.text}>{` ${name}`}</text>
          <box flexGrow={1} />
          <text bg={hud.slab} fg={hud.amber}>{` ×${count} `}</text>
        </box>
      ))}
    </box>
  );
}

function Loadout({ rows }: { readonly rows: number }) {
  return (
    <box flexDirection="column">
      <box backgroundColor={tones.amber.deep} flexDirection="row">
        <text bg={tones.amber.deep} fg={hud.amber}>
          ▌<b>task-notes</b>
        </text>
        <box flexGrow={1} />
        <text bg={tones.amber.deep} fg={tones.amber.dim}>
          {"skill "}
        </text>
      </box>
      <box flexDirection="row">
        <text bg={hud.screen} fg={hud.text}>
          {" backlog"}
        </text>
        <box flexGrow={1} />
        <text bg={hud.screen} fg={hud.dim}>
          {"mcp "}
        </text>
      </box>
      {Array.from({ length: Math.max(rows - 2, 0) }, (_, slot) => (
        <text bg={hud.screen} fg={hud.iron[4]} key={`slot-${slot}`}>
          {" · empty slot"}
        </text>
      ))}
    </box>
  );
}

function Speaker({
  note,
  tone,
  who,
}: {
  readonly note?: string;
  readonly tone: "amber" | "steel";
  readonly who: string;
}) {
  return (
    <box flexDirection="row" gap={1}>
      <Chip tone={tone}>{who}</Chip>
      {note ? (
        <text bg={hud.screen} fg={hud.dim}>
          {note}
        </text>
      ) : null}
    </box>
  );
}

function Line({ children }: { readonly children: string }) {
  return (
    <text bg={hud.screen} fg={hud.text}>
      {children}
    </text>
  );
}

function Talk() {
  return (
    <box flexDirection="column" paddingTop={1}>
      <Speaker tone="steel" who="YOU" />
      <Line>Read package.json here and explain how to run this example.</Line>
      <text> </text>
      <Speaker note="Locate package.json" tone="amber" who="AGENT" />
      <Slab label="TOOL" tone="amber">
        Read package.json
      </Slab>
      <Slab label="RESULT" tone="green">
        Two scripts found: start and test.
      </Slab>
      <Line>This example starts with bun run start.</Line>
      <text> </text>
      <Speaker note="Check setup" tone="amber" who="AGENT" />
      <Slab detail="1.2s" label="TOOL" tone="amber">
        Bash bun run --help
      </Slab>
    </box>
  );
}

function Goal() {
  return (
    <text bg={hud.screen} fg={hud.dim}>
      Message the agent…
    </text>
  );
}

const KEYS = [
  ["↵", "Send"],
  ["Tab", "Loadout"],
  ["a", "Avatar"],
  ["PgUp/PgDn", "Scroll"],
  ["^C", "Quit"],
] as const;

function Hints({ width }: { readonly width: number }) {
  let used = 0;
  const shown = KEYS.filter(([key, action]) => {
    const next = used + key.length + action.length + 4;
    if (next > width + 1) {
      return false;
    }
    used = next;
    return true;
  });
  return (
    <box flexDirection="row" gap={1}>
      {shown.map(([key, action]) => (
        <box flexDirection="row" flexShrink={0} gap={1} key={key}>
          <Chip ground={hud.grain[1]} tone="steel">
            {key}
          </Chip>
          <text bg={hud.grain[1]} fg={hud.text}>
            {action}
          </text>
        </box>
      ))}
    </box>
  );
}

function plan(size: Size) {
  if (hudGeometry(size, []).dense) {
    return { gap: 1, portrait: 7, vitals: 7 };
  }
  return { gap: 1, portrait: size.height >= TALL ? 11 : 9, vitals: 7 };
}

function regions(size: Size): HudSection[] {
  return [
    {
      content: <Region>portrait and comment</Region>,
      key: "portrait",
      rows: plan(size).portrait,
    },
    {
      content: <Region>context · stamina</Region>,
      key: "vitals",
      rows: plan(size).vitals,
      title: "VITALS",
    },
    {
      content: <Region>tools used, once each</Region>,
      key: "arsenal",
      rows: 3,
      title: "ARSENAL",
    },
    {
      content: <Region>skills and MCP</Region>,
      grow: true,
      key: "loadout",
      title: "LOADOUT",
    },
  ];
}

function sketch(size: Size, detail: Detail): HudSection[] {
  const { gap, portrait: rows, vitals } = plan(size);
  const slots = hudGeometry(size, regions(size)).parts.at(-1)?.body.height;
  return [
    {
      bleed: true,
      content: (
        <PortraitBay
          caption="holding steady"
          detail={detail}
          rows={rows}
          width={24}
        />
      ),
      key: "portrait",
      rows,
    },
    {
      content: <Vitals detail={detail} gap={gap} />,
      key: "vitals",
      meta: "160k tok",
      rows: plan(size).vitals,
      title: "VITALS",
    },
    {
      content: <Arsenal />,
      key: "arsenal",
      meta: "11 calls",
      rows: 3,
      title: "ARSENAL",
    },
    {
      content: <Loadout rows={slots ?? 2} />,
      grow: true,
      key: "loadout",
      meta: "2 slots",
      title: "LOADOUT",
    },
  ];
}

function screen(
  size: Size,
  sections: HudSection[],
  main: ReactNode,
  detail: Detail = "fine"
) {
  const { hints, steps } = hudGeometry(size, sections);
  return (
    <HudLayout
      detail={detail}
      goal={<Goal />}
      hints={<Hints width={hints.width} />}
      main={main}
      onResize={ignore}
      sections={sections}
      size={size}
      steps={<StepStrip detail={detail} steps={STEPS} width={steps.width} />}
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
      screen(wide, regions(wide), <Region>conversation</Region>),
      padless(wide)
    ),
});

export const Sketch = story({
  description: "The regions filled with stand-in content, to judge the look.",
  name: "Sketch",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(wide, sketch(wide, "fine"), <Talk />),
      padless(wide)
    ),
});

export const Compact = story({
  description: "The same sketch at 96 by 30.",
  name: "Compact",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(compact, sketch(compact, "fine"), <Talk />),
      padless(compact)
    ),
});

export const Small = story({
  description: "The same sketch at 80 by 24, with one-row section heads.",
  name: "Small",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(small, sketch(small, "fine"), <Talk />),
      padless(small)
    ),
});

export const Coarse = story({
  description:
    "The sketch in the half-block tier, for terminals without sextant glyphs.",
  name: "Coarse",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(wide, sketch(wide, "coarse"), <Talk />, "coarse"),
      padless(wide)
    ),
});
