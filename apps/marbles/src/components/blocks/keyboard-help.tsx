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
          { key: "Shift+D / Shift+F", value: "Show the Dashboard / Feed tab" },
          {
            key: "↑ / ↓ · Enter in Feed",
            value: "Select an entry · read it; Esc returns to the list",
          },
          {
            key: "w / x in Feed",
            value: "Cycle workspace filter / show all workspaces",
          },
          {
            key: "1-9 / a in Feed",
            value:
              "Answer by choice (an approval then takes an optional note) / type a free-text answer",
          },
          {
            key: "1 / 2 / 3",
            value: "Focus Triggers / Marbles / Runs",
          },
          {
            key: "Tab / Shift+Tab",
            value: "Move focus through the three dashboard panels",
          },
          { key: "m", value: "Focus Marbles" },
          { key: "l on Marbles", value: "Launch selected step or workflow" },
          {
            key: "Tab / Ctrl+Enter in forms",
            value: "Move focus / submit arguments",
          },
          { key: "h / click marbles", value: "Return to the dashboard" },
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
            key: "s / p / k on a run",
            value:
              "Steer the running agent / pause or resume the step / cancel the run",
          },
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
