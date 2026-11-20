import { type ReactNode, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Tabs } from "~/components/ui/tabs";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "../frame";

type Section = "overview" | "runs" | "logs";

const sections: readonly {
  readonly content: ReactNode;
  readonly key: Section;
  readonly label: string;
}[] = [
  {
    content: <Text>3 workflows, 12 runs today.</Text>,
    key: "overview",
    label: "Overview",
  },
  {
    content: <Text>nightly-digest · complete · 2m 18s</Text>,
    key: "runs",
    label: "Runs",
  },
  {
    content: <Text>09:15:07 [error] Step summarise failed</Text>,
    key: "logs",
    label: "Logs",
  },
];

const inspector = [
  "Overview",
  "Input",
  "Result",
  "Logs",
  "Usage",
  "Configuration",
].map((label) => ({
  content: <Text>{`${label} for the selected step.`}</Text>,
  key: label.toLowerCase(),
  label,
}));

function SwitchableTabs() {
  const [active, setActive] = useState<Section>("overview");
  return <Tabs activeTab={active} onTabChange={setActive} tabs={sections} />;
}

export default defineStories({
  component: "Tabs",
  description: "A row of tab actions above the active tab's content.",
  title: "UI/Tabs",
});

export const ClickToSwitch = story({
  description: "Three tabs; clicking a tab shows its content.",
  name: "Click to switch",
  render: (renderer) =>
    renderFrame(renderer, <SwitchableTabs />, { height: 6, width: 50 }),
});

export const Wrapped = story({
  description: "Many tabs in a narrow box wrap onto more rows.",
  name: "Wrapped",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Tabs activeTab="usage" onTabChange={ignore} tabs={inspector} />,
      { height: 8, width: 28 }
    ),
});
