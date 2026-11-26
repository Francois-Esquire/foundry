import { afterEach, expect, test } from "vitest";
import { DashboardView } from "../src/tui/views/dashboard";
import { previewScenarios } from "../stories/fixtures/scenarios";
import { mount, unmount } from "./helpers/render";

const close = () => undefined;

afterEach(unmount);

test("every scenario renders at narrow and wide dimensions", async () => {
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
      expect(ui.captureCharFrame()).toContain("Ctrl+C quit");
    }
  }
});
