import type { ReactNode } from "react";
import { defineStories, story } from "textbook-sh";
import { Gauge } from "@/components/blocks/gauge";
import { HudLayout, type HudSection } from "@/components/layouts/hud";
import { hud } from "@/model/palette";
import type { Size } from "@/model/screen";
import { ignore, renderFrame } from "../frame";

const wide = { height: 34, width: 120 };
const compact = { height: 30, width: 90 };
const TITLE = "READ PACKAGE.JSON AND EXPLAIN HOW TO RUN THIS EXAMPLE";
const SPENT = "159K IN · 1.3K OUT";
const PORTRAIT_ROWS = 12;

export default defineStories({
  component: "HudLayout",
  description:
    "A blockout of the next screen: a status rail of stacked plates on the left, the conversation and goal on the right.",
  title: "Layouts/Hud",
});

function Region({ children }: { readonly children: string }) {
  return <text fg={hud.dim}>{children}</text>;
}

function Portrait() {
  return (
    <box flexDirection="column" paddingTop={1}>
      <box backgroundColor={hud.screen} flexDirection="column">
        {Array.from({ length: PORTRAIT_ROWS }, (_, row) => (
          <text fg={hud.trough} key={`portrait-${row}`}>
            {row === PORTRAIT_ROWS / 2
              ? "░░░░░░░ PORTRAIT ░░░░░░░"
              : "░".repeat(24)}
          </text>
        ))}
      </box>
      <box flexDirection="row" justifyContent="center">
        <text fg={hud.amber}>"HOLDING STEADY"</text>
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
        <text fg={hud.dim}>{label}</text>
        <box flexGrow={1} />
        <text fg={tone}>
          <b>{value}</b>
        </text>
      </box>
      <Gauge cells={26} level={level} tone={tone} />
    </box>
  );
}

function Vitals() {
  return (
    <box flexDirection="column">
      <Vital label="CONTEXT LEFT" level={0.62} tone={hud.blood} value="62%" />
      <Vital label="EFFORT" level={0.75} tone={hud.amber} value="HIGH" />
    </box>
  );
}

function Checkpoints() {
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={hud.ok}>██ ██ </span>
        <span fg={hud.amber}>██ </span>
        <span fg={hud.trough}>██</span>
      </text>
      <text fg={hud.text} wrapMode="none">
        Check prerequisite setup
      </text>
    </box>
  );
}

function Arsenal() {
  return (
    <box flexDirection="column">
      {[
        ["BASH", "6"],
        ["READ", "4"],
        ["SKILL", "1"],
      ].map(([name, count]) => (
        <box flexDirection="row" key={name}>
          <text fg={hud.text}>{name}</text>
          <box flexGrow={1} />
          <text fg={hud.amber}>
            <b>{count}</b>
          </text>
        </box>
      ))}
    </box>
  );
}

function Loadout() {
  return (
    <box flexDirection="column">
      <box backgroundColor={hud.ember} flexDirection="row">
        <text fg={hud.amber}>
          <b>TASK-NOTES</b>
        </text>
        <box flexGrow={1} />
        <text fg={hud.amber}>SKILL</text>
      </box>
      <box flexDirection="row">
        <text fg={hud.text}>BACKLOG</text>
        <box flexGrow={1} />
        <text fg={hud.dim}>MCP</text>
      </box>
    </box>
  );
}

function regions(): HudSection[] {
  return [
    { content: <Region>portrait and comment</Region>, key: "portrait" },
    {
      content: <Region>context left · effort</Region>,
      key: "vitals",
      title: "VITALS",
    },
    {
      content: <Region>to-do markers · current to-do</Region>,
      key: "checkpoints",
      meta: "0/0",
      title: "CHECKPOINTS",
    },
    {
      content: <Region>tools used, once each</Region>,
      key: "arsenal",
      title: "ARSENAL",
    },
    {
      content: <Region>skills and MCP servers, selectable</Region>,
      grow: true,
      key: "loadout",
      title: "LOADOUT",
    },
  ];
}

function sketch(): HudSection[] {
  return [
    { content: <Portrait />, key: "portrait" },
    { content: <Vitals />, key: "vitals", title: "VITALS" },
    {
      content: <Checkpoints />,
      key: "checkpoints",
      meta: "2/4",
      title: "CHECKPOINTS",
    },
    { content: <Arsenal />, key: "arsenal", meta: "11", title: "ARSENAL" },
    {
      content: <Loadout />,
      grow: true,
      key: "loadout",
      meta: "2",
      title: "LOADOUT",
    },
  ];
}

function Talk() {
  return (
    <box flexDirection="column" paddingY={1}>
      <text fg={hud.amber}>
        <b>YOU</b>
      </text>
      <text fg={hud.text}>
        Read package.json here and explain how to run this.
      </text>
      <text> </text>
      <text fg={hud.ok}>
        <b>01 LOCATE AND READ PACKAGE.JSON</b>
      </text>
      <text fg={hud.dim}>
        <span fg={hud.ok}>■</span> Read package.json
      </text>
      <text fg={hud.text}>This example starts with bun run start.</text>
      <text> </text>
      <text fg={hud.amber}>
        <b>02 IDENTIFY THE RUN SCRIPTS</b>
      </text>
      <text fg={hud.dim}>
        <span fg={hud.amber}>■</span> Bash bun run --help
        <span fg={hud.amber}> 1.2s</span>
      </text>
    </box>
  );
}

function Goal() {
  return (
    <box flexDirection="row" gap={1}>
      <text bg={hud.blood} fg={hud.screen}>
        <b> GOAL </b>
      </text>
      <text fg={hud.dim}>Give the harness a goal</text>
    </box>
  );
}

function screen(sections: HudSection[], main: ReactNode, size: Size) {
  return renderSize(
    <HudLayout
      goal={<Goal />}
      main={main}
      meta={SPENT}
      onResize={ignore}
      sections={sections}
      title={TITLE}
    />,
    size
  );
}

function renderSize(content: ReactNode, size: Size) {
  return { content, size: { ...size, padded: false } };
}

export const Regions = story({
  description: "Every region labelled with what will go there.",
  name: "Regions",
  render: (renderer) => {
    const { content, size } = screen(
      regions(),
      <Region>conversation</Region>,
      wide
    );
    return renderFrame(renderer, content, size);
  },
});

export const Sketch = story({
  description: "The regions filled with stand-in content, to judge the look.",
  name: "Sketch",
  render: (renderer) => {
    const { content, size } = screen(sketch(), <Talk />, wide);
    return renderFrame(renderer, content, size);
  },
});

export const Compact = story({
  description: "The same sketch at 90 by 30.",
  name: "Compact",
  render: (renderer) => {
    const { content, size } = screen(sketch(), <Talk />, compact);
    return renderFrame(renderer, content, size);
  },
});
