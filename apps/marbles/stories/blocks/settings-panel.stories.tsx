import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { settingsView } from "~/cli/theme";
import { SettingsBlock } from "~/components/blocks/settings-panel";
import type { ThemeName } from "~/model/settings";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";

const size = { height: 24, width: 46 };

const settings = settingsView(
  dashboardSnapshot.settings ?? {
    path: "~/.foundry/marbles/settings.json",
    theme: "dark",
  }
);

const names = settings.themes.map((choice) => choice.name);

const broken = settingsView({
  path: "~/.foundry/marbles/settings.json",
  problem: "Cannot read settings: Unexpected token } in JSON at position 41",
  theme: "dark",
});

function ChooseTheme() {
  const [current, setCurrent] = useState<ThemeName>(settings.theme);
  const [rail, setRail] = useState(true);
  useKeyboard((key) => {
    if (key.name !== "left" && key.name !== "right") {
      return;
    }
    key.preventDefault();
    const step = key.name === "right" ? 1 : -1;
    setCurrent((name) => {
      const index = names.indexOf(name) + step;
      return names[(index + names.length) % names.length] ?? name;
    });
  });
  return (
    <SettingsBlock
      onRail={setRail}
      onTheme={setCurrent}
      rail={rail}
      settings={settingsView({ ...settings, theme: current })}
    />
  );
}

export default defineStories({
  component: "SettingsBlock",
  description:
    "The settings drawer: the theme list with swatches and the workspace navigation choice.",
  title: "Blocks/SettingsBlock",
});

export const Choose = story({
  description:
    "Left and Right or a click choose a theme; the rail choice toggles. The story does not repaint the palette.",
  name: "Choose",
  render: (renderer) => renderFrame(renderer, <ChooseTheme />, size),
});

export const Editable = story({
  description: "A host that saves settings lists every theme to choose from.",
  name: "Editable",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SettingsBlock onTheme={ignore} settings={settings} />,
      size
    ),
});

export const ReadOnly = story({
  description: "A host that cannot save settings shows the theme alone.",
  name: "Read-only",
  render: (renderer) =>
    renderFrame(renderer, <SettingsBlock settings={settings} />, {
      height: 12,
      width: 46,
    }),
});

export const Problem = story({
  description:
    "A settings file that cannot be read shows the problem and its path.",
  name: "Problem",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SettingsBlock onTheme={ignore} settings={broken} />,
      size
    ),
});

export const NoSettings = story({
  description: "A host with no settings at all.",
  name: "No settings",
  render: (renderer) =>
    renderFrame(renderer, <SettingsBlock />, { height: 8, width: 46 }),
});

export const RailOnly = story({
  description:
    "No settings, but the workspace navigation choice, with the picker chosen.",
  name: "Navigation only",
  render: (renderer) =>
    renderFrame(renderer, <SettingsBlock onRail={ignore} rail={false} />, {
      height: 10,
      width: 46,
    }),
});

export const Narrow = story({
  description: "Long theme names are cut to keep the swatches visible.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SettingsBlock
        onRail={ignore}
        onTheme={ignore}
        rail
        settings={settings}
      />,
      { height: 24, width: 26 }
    ),
});
