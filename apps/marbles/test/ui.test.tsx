import { afterEach, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { JSONView } from "../src/components/ui/json";
import { Log } from "../src/components/ui/log";
import type { LogEntry } from "../src/components/ui/types";
import { flush, mount, press, unmount } from "./helpers/render";

afterEach(unmount);

test("JSON array items collapse independently and inactive viewers ignore keys", async () => {
  let ui = await mount(
    <JSONView data={[{ item: "first" }, { item: "second" }]} focused />,
    { height: 15, width: 80 }
  );
  await press(ui, "ARROW_DOWN");
  await press(ui, " ");
  expect(ui.captureCharFrame()).not.toContain('item: "first"');
  expect(ui.captureCharFrame()).toContain('item: "second"');
  ui = await mount(
    <JSONView data={[{ item: "first" }, { item: "second" }]} focused={false} />,
    { height: 15, width: 80 }
  );
  await press(ui, " ");
  expect(ui.captureCharFrame()).toContain('item: "first"');
  expect(ui.captureCharFrame()).toContain('item: "second"');
});

const logEntries: readonly LogEntry[] = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `log-${index}`,
    level: "info",
    message: `Message ${index}`,
    timestamp: "14:00:00",
  })
);
let appendLogs: (() => void) | undefined;
function UpdatingLogs() {
  const [entries, setEntries] = useState(logEntries);
  useEffect(() => {
    appendLogs = () =>
      setEntries((previous) => [
        ...previous,
        {
          id: "new-log",
          level: "info",
          message: "Newest message",
          timestamp: "14:00:01",
        },
      ]);
    return () => {
      appendLogs = undefined;
    };
  }, []);
  return <Log entries={entries} focused />;
}

test("following logs advances to new entries and pausing retains the visible position", async () => {
  const ui = await mount(<UpdatingLogs />, { height: 15, width: 80 });
  expect(ui.captureCharFrame()).toContain("Message 0");
  await press(ui, "f");
  expect(ui.captureCharFrame()).toContain("Message 11");
  await act(async () => {
    appendLogs?.();
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Newest message");
  await press(ui, "f");
  expect(ui.captureCharFrame()).toContain("Newest message");
  expect(ui.captureCharFrame()).not.toContain("Message 0");
  await press(ui, "ARROW_UP");
  expect(ui.captureCharFrame()).not.toContain("Newest message");
  expect(ui.captureCharFrame()).toContain("Paused");
});
