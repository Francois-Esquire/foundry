import { defineStories, story } from "textbook-sh";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "./frame";

function Swatches() {
  return (
    <box flexDirection="column">
      {Object.entries(theme.colors).map(([name, color]) => (
        <text fg={theme.colors.foreground} key={name}>
          <span bg={color}>{"      "}</span>
          {` ${name.padEnd(18)} ${color}`}
        </text>
      ))}
    </box>
  );
}

function BorderSample({
  color,
  label,
}: {
  readonly color: string;
  readonly label: string;
}) {
  return (
    <box
      border
      borderColor={color}
      borderStyle={theme.border.style}
      height={4}
      paddingX={1}
      title={label}
      width={26}
    >
      <text fg={theme.colors.foreground}>{color}</text>
    </box>
  );
}

function Borders() {
  return (
    <>
      <text fg={theme.colors.mutedForeground}>
        Border style: {theme.border.style}
      </text>
      <box flexDirection="row" gap={2}>
        <BorderSample color={theme.border.color} label="color" />
        <BorderSample color={theme.border.focusColor} label="focusColor" />
      </box>
    </>
  );
}

export default defineStories({
  component: "theme",
  description: "The active palette: colours and border.",
  title: "UI/Theme",
});

export const Colours = story({
  description: "Every theme colour as a swatch with its name and value.",
  name: "Colours",
  render: (renderer) =>
    renderFrame(renderer, <Swatches />, { height: 14, width: 44 }),
});

export const Border = story({
  description: "The border style with its plain and focus colours.",
  name: "Border",
  render: (renderer) =>
    renderFrame(renderer, <Borders />, { height: 8, width: 58 }),
});
