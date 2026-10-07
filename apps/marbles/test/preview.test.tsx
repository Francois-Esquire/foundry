import { afterEach, expect, test } from "bun:test";
import { sleep } from "bun";
import { act } from "react";
import { PreviewApp } from "../preview/app";
import { previewScenarios } from "../preview/scenarios";
import { DashboardView } from "../src/views/dashboard";
import { flush, mount, press, unmount } from "./helpers/render";

function close() {
  // The preview never quits in these tests.
}

afterEach(unmount);

test("preview switches scenarios and advances deterministic playback", async () => {
  const ui = await mount(<PreviewApp onClose={close} />);
  expect(ui.captureCharFrame()).toContain("Frame 3/4");
  await press(ui, "r");
  expect(ui.captureCharFrame()).toContain("Frame 1/4");
  await press(ui, "n");
  expect(ui.captureCharFrame()).toContain("Frame 2/4");
  await press(ui, "]");
  expect(ui.captureCharFrame()).toContain(
    `Scenario 2/${previewScenarios.length}: Idle`
  );
  expect(ui.captureCharFrame()).toContain("No runs yet.");
  await press(ui, "[");
  expect(ui.captureCharFrame()).toContain("Frame 1/4");
  await press(ui, "p");
  expect(ui.captureCharFrame()).toContain("p Pause");
  await act(async () => {
    await sleep(1300);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Frame 2/4");
  await press(ui, "p");
  expect(ui.captureCharFrame()).toContain("p Play");
  await act(async () => {
    await sleep(1300);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Frame 2/4");
});

test("every preview scenario renders at narrow and wide dimensions", async () => {
  for (const scenario of previewScenarios) {
    for (const width of [70, 120]) {
      const [snapshot] = scenario.frames;
      if (!snapshot) {
        throw new Error("Scenario is missing a frame");
      }
      const ui = await mount(
        <DashboardView onClose={close} snapshot={snapshot} />,
        { height: 30, width }
      );
      expect(ui.captureCharFrame()).toContain("preview");
      expect(ui.captureCharFrame()).toContain("Ctrl+C quit");
    }
  }
});
