import type { ReactNode } from "react";
import { defineStories, story } from "textbook-sh";
import { HudLayout, type HudSection } from "@/components/layouts/hud";
import { defaultTheme } from "@/lib/terminal-themes/default";
import type { Size } from "@/model/screen";
import { ignore, renderFrame } from "../frame";

const { colors } = defaultTheme;
const wide = { height: 34, width: 120 };
const compact = { height: 30, width: 90 };
const TITLE = "Read package.json and explain how to run this example";
const PORTRAIT_ROWS = 12;

export default defineStories({
  component: "HudLayout",
  description:
    "A blockout of the next screen: a status rail of stacked sections on the left, the conversation and goal on the right, inside one ornate frame.",
  title: "Layouts/Hud",
});

function Region({ children }: { readonly children: string }) {
  return <text fg={colors.mutedForeground}>{children}</text>;
}

function Portrait() {
  return (
    <box flexDirection="column">
      {Array.from({ length: PORTRAIT_ROWS }, (_, row) => (
        <text fg={colors.muted} key={`portrait-${row}`}>
          {"▓".repeat(24)}
        </text>
      ))}
      <box flexDirection="row" justifyContent="center">
        <text fg={colors.foreground}>"holding steady"</text>
      </box>
    </box>
  );
}

function Gauge({
  filled,
  icon,
  tone,
  value,
}: {
  readonly filled: number;
  readonly icon: string;
  readonly tone: string;
  readonly value: string;
}) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={tone}>{icon}</text>
      <text fg={tone}>
        {"▰".repeat(filled)}
        <span fg={colors.muted}>{"▱".repeat(14 - filled)}</span>
      </text>
      <text fg={colors.mutedForeground}>{value}</text>
    </box>
  );
}

function regions(): HudSection[] {
  return [
    {
      content: <Region>portrait and comment</Region>,
      height: PORTRAIT_ROWS + 1,
      key: "portrait",
    },
    {
      content: <Region>context · effort</Region>,
      height: 2,
      key: "vitals",
      title: "VITALS",
    },
    {
      content: <Region>to-do markers · current to-do</Region>,
      height: 2,
      key: "checkpoints",
      meta: "0/0",
      title: "CHECKPOINTS",
    },
    {
      content: <Region>tools used, once each</Region>,
      height: 2,
      key: "arsenal",
      title: "ARSENAL",
    },
    {
      content: <Region>tokens in · out</Region>,
      height: 1,
      key: "spent",
      title: "SPENT",
    },
    {
      content: <Region>skills and MCP servers, selectable</Region>,
      height: "fill",
      key: "loadout",
      title: "LOADOUT",
    },
  ];
}

function sketch(): HudSection[] {
  return [
    { content: <Portrait />, height: PORTRAIT_ROWS + 1, key: "portrait" },
    {
      content: (
        <>
          <Gauge filled={9} icon="♥" tone={colors.success} value="62%" />
          <Gauge filled={10} icon="ϟ" tone={colors.warning} value="high" />
        </>
      ),
      height: 2,
      key: "vitals",
      title: "VITALS",
    },
    {
      content: (
        <>
          <text>
            <span fg={colors.success}>◆ ◆ </span>
            <span fg={colors.primary}>◈ </span>
            <span fg={colors.mutedForeground}>◇</span>
          </text>
          <text fg={colors.primary} wrapMode="none">
            Check prerequisite setup
          </text>
        </>
      ),
      height: 2,
      key: "checkpoints",
      meta: "2/4",
      title: "CHECKPOINTS",
    },
    {
      content: (
        <text fg={colors.foreground} wrapMode="word">
          Bash ×6 Read ×4 Skill ×1
        </text>
      ),
      height: 2,
      key: "arsenal",
      title: "ARSENAL",
    },
    {
      content: <text fg={colors.mutedForeground}>159k in · 1.3k out</text>,
      height: 1,
      key: "spent",
      title: "SPENT",
    },
    {
      content: (
        <>
          <text bg={colors.muted} fg={colors.foreground} wrapMode="none">
            {"▸ task-notes       skill "}
          </text>
          <text fg={colors.mutedForeground} wrapMode="none">
            {"  backlog · 1 tool   mcp "}
          </text>
        </>
      ),
      height: "fill",
      key: "loadout",
      meta: "2",
      title: "LOADOUT",
    },
  ];
}

function Talk() {
  return (
    <box flexDirection="column">
      <text fg={colors.primary}>
        <b>You</b>
      </text>
      <text>Read package.json here and explain how to run this.</text>
      <text> </text>
      <text fg={colors.success}>
        <b>Task 1 · Locate and read package.json</b>
      </text>
      <text fg={colors.success}>✓ Read package.json</text>
      <text>This example starts with bun run start.</text>
      <text> </text>
      <text fg={colors.success}>
        <b>Task 2 · Identify the run scripts</b>
      </text>
      <text fg={colors.primary}>⠹ Bash (1.2s) bun run --help</text>
    </box>
  );
}

function screen(sections: HudSection[], main: ReactNode, size: Size) {
  return (
    <HudLayout
      goal={
        <text fg={colors.mutedForeground}>
          <span fg={colors.primary}>› </span>Give the harness a goal
        </text>
      }
      main={main}
      onResize={ignore}
      sections={sections}
      size={size}
      title={TITLE}
    />
  );
}

export const Regions = story({
  description: "Every region labelled with what will go there.",
  name: "Regions",
  render: (renderer) =>
    renderFrame(
      renderer,
      screen(regions(), <Region>conversation</Region>, wide),
      { ...wide, padded: false }
    ),
});

export const Sketch = story({
  description: "The regions filled with stand-in content, to judge the look.",
  name: "Sketch",
  render: (renderer) =>
    renderFrame(renderer, screen(sketch(), <Talk />, wide), {
      ...wide,
      padded: false,
    }),
});

export const Compact = story({
  description: "The same sketch at 90 by 30.",
  name: "Compact",
  render: (renderer) =>
    renderFrame(renderer, screen(sketch(), <Talk />, compact), {
      ...compact,
      padded: false,
    }),
});
