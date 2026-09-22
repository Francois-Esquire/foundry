import { Panel } from "~/components/panel";
import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";

export function KeyboardHelp({ active = true }: { readonly active?: boolean }) {
  return (
    <Panel
      active={active}
      scrollable={active}
      title="Keyboard help · Esc or ? closes"
    >
      <KeyValue
        items={[
          {
            key: "1 / 2 / 3",
            value: "Focus Triggers / Catalog / Runs",
          },
          {
            key: "Tab / Shift+Tab",
            value: "Move focus through the three dashboard panels",
          },
          { key: "c", value: "Focus Catalog" },
          { key: "l on catalog", value: "Launch selected step or workflow" },
          {
            key: "Tab / Ctrl+Enter in forms",
            value: "Move focus / submit arguments",
          },
          { key: "h / click quirks", value: "Return to the dashboard" },
          { key: "↑ / ↓", value: "Select rows or scroll the inspector" },
          {
            key: "Enter / Esc",
            value: "Open details / return to selected pane",
          },
          {
            key: "← / →",
            value: "Collapse / expand run branches; change inspector tab",
          },
          {
            key: "PgUp / PgDn",
            value: "Scroll the whole inspector in short terminals",
          },
          { key: "Space", value: "Toggle run branch or selected JSON node" },
          {
            key: "a / e",
            value: "Jump to active step / failure within the run filter",
          },
          { key: "b", value: "Return from step details to its run" },
          { key: "/", value: "Search the focused catalog or run list" },
          { key: "Enter / Esc in search", value: "Keep search / clear search" },
          {
            key: "f on catalog",
            value: "Filter runs to this schedule, monitor, workflow, or step",
          },
          { key: "x", value: "Clear all searches and the run filter" },
          {
            key: "f in logs",
            value: "Toggle following new logs; scrolling pauses follow",
          },
          { key: "q / Ctrl+C", value: "Confirm quit; Ctrl+C again quits" },
        ]}
      />
      <Text>
        Mouse: open row details, toggle branch arrows, switch inspector tabs, or
        follow breadcrumbs.
      </Text>
    </Panel>
  );
}
