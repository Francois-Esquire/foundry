import type { ReactNode } from "react";
import { defineStories, story } from "textbook-sh";
import { Gauge } from "@/components/blocks/gauge";
import { HudLayout, type HudSection } from "@/components/layouts/hud";
import { hud } from "@/model/palette";
import type { Size } from "@/model/screen";
import { ignore, renderFrame } from "../frame";

const wide = { height: 34, width: 120 };
const compact = { height: 30, width: 96 };
const PORTRAIT_ROWS = 10;

export default defineStories({
  component: "HudLayout",
  description:
    "A blockout of the next screen: a status rail of cards on the left, the steps, conversation and goal on the right.",
  title: "Layouts/Hud",
});

function Region({ children }: { readonly children: string }) {
  return <text fg={hud.dim}>{children}</text>;
}

function Portrait() {
  return (
    <box alignItems="center" flexDirection="column">
      {Array.from({ length: PORTRAIT_ROWS }, (_, row) => (
        <text fg={hud.trough} key={`portrait-${row}`}>
          {row === PORTRAIT_ROWS / 2
            ? "▒▒▒▒▒▒ portrait ▒▒▒▒▒▒"
            : "▒".repeat(22)}
        </text>
      ))}
      <text fg={hud.amber}>holding steady</text>
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
        <text fg={hud.dim}>{value}</text>
      </box>
      <Gauge cells={26} level={level} tone={tone} />
    </box>
  );
}

function Vitals() {
  return (
    <box flexDirection="column" gap={1}>
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
        ["Bash", "6"],
        ["Read", "4"],
        ["Skill", "1"],
      ].map(([name, count]) => (
        <box flexDirection="row" gap={1} key={name}>
          <text fg={hud.ok}>●</text>
          <text fg={hud.text}>{name}</text>
          <box flexGrow={1} />
          <text fg={hud.dim}>{`×${count}`}</text>
        </box>
      ))}
    </box>
  );
}

function Loadout() {
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={hud.amber}>▸</text>
        <text fg={hud.amber}>
          <b>task-notes</b>
        </text>
        <box flexGrow={1} />
        <text fg={hud.dim}>skill</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={hud.dim}> </text>
        <text fg={hud.text}>backlog</text>
        <box flexGrow={1} />
        <text fg={hud.dim}>mcp</text>
      </box>
    </box>
  );
}

function Steps() {
  return (
    <text wrapMode="none">
      <span fg={hud.ok}>✓ 1 Locate package.json</span>
      <span fg={hud.bronze}>{"  ›  "}</span>
      <span fg={hud.ok}>✓ 2 Identify scripts</span>
      <span fg={hud.bronze}>{"  ›  "}</span>
      <span fg={hud.amber}>
        <b>▶ 3 Check setup</b>
      </span>
      <span fg={hud.bronze}>{"  ›  "}</span>
      <span fg={hud.dim}>4 Summarize</span>
    </text>
  );
}

function Card({
  children,
  label,
  tone,
}: {
  readonly children: string;
  readonly label: string;
  readonly tone: string;
}) {
  return (
    <box
      border
      borderColor={tone}
      borderStyle="rounded"
      flexDirection="row"
      gap={2}
      paddingX={1}
    >
      <text fg={tone}>
        <b>{label}</b>
      </text>
      <text fg={hud.text}>{children}</text>
    </box>
  );
}

function Talk() {
  return (
    <box flexDirection="column">
      <text fg={hud.amber}>
        <b>YOU</b>
      </text>
      <text fg={hud.text}>
        Read package.json here and explain how to run this example.
      </text>
      <text> </text>
      <text fg={hud.amber}>
        <b>AGENT</b>
        <span fg={hud.dim}> · Locate package.json</span>
      </text>
      <Card label="TOOL" tone={hud.bronze}>
        Read package.json
      </Card>
      <Card label="RESULT" tone={hud.okDim}>
        Two scripts found: start and test.
      </Card>
      <text fg={hud.text}>This example starts with bun run start.</text>
      <text> </text>
      <text fg={hud.amber}>
        <b>AGENT</b>
        <span fg={hud.dim}> · Check setup</span>
      </text>
      <Card label="TOOL" tone={hud.amber}>
        Bash bun run --help · 1.2s
      </Card>
    </box>
  );
}

function Goal() {
  return (
    <text fg={hud.dim}>
      <span fg={hud.amber}>{">_ "}</span>Message the agent…
    </text>
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
          <span fg={hud.amber}>{`[${key}]`}</span>
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

function sketch(): HudSection[] {
  return [
    { content: <Portrait />, key: "portrait" },
    {
      content: <Vitals />,
      key: "vitals",
      meta: "159k in · 1.3k out",
      title: "VITALS",
    },
    {
      content: <Arsenal />,
      key: "arsenal",
      meta: "11 calls",
      title: "ARSENAL",
    },
    {
      content: <Loadout />,
      grow: true,
      key: "loadout",
      meta: "2",
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
  render: (renderer) =>
    renderFrame(renderer, screen(sketch(), <Talk />, <Steps />), padless(wide)),
});

export const Compact = story({
  description: "The same sketch at 96 by 30.",
  name: "Compact",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(sketch(), <Talk />, <Steps />),
      padless(compact)
    ),
});
