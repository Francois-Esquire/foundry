// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RenderStatus } from "../../src/web/scene/pipeline";
import {
  defaultRenderSettings,
  type RenderSettings,
} from "../../src/web/settings/chart-settings";
import { RenderingSettings } from "../../src/web/ui/rendering-settings";

const status: RenderStatus = {
  adapted: false,
  backend: "webgl",
  failure: null,
  frameMs: null,
  globalIlluminationAvailable: false,
  postProcessing: true,
  quality: "medium",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function control(name: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[name="${name}"]`
  );
  if (!element) {
    throw new Error(`Missing ${name}`);
  }
  return element;
}
async function mount(initial = defaultRenderSettings) {
  const changed = vi.fn();
  function Harness() {
    const [settings, setSettings] = useState<RenderSettings>(initial);
    return createElement(RenderingSettings, {
      disabled: false,
      onChange: (next: RenderSettings) => {
        changed(next);
        setSettings(next);
      },
      settings,
      status,
    });
  }
  await act(() => root.render(createElement(Harness)));
  return changed;
}
it("keeps quality usable when effects are off and restores live controls", async () => {
  const changed = await mount({ ...defaultRenderSettings, quality: "off" });
  expect(control("quality").disabled).toBe(false);
  expect(control("exposure").disabled).toBe(true);
  await act(() => {
    control("quality").value = "medium";
    control("quality").dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(control("exposure").disabled).toBe(false);
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ exposure: 1, quality: "medium" })
  );
});
it("returns to the final image when the previewed effect is switched off", async () => {
  const changed = await mount({ ...defaultRenderSettings, stage: "bloom" });
  await act(() => control("bloom").click());
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ bloom: false, stage: "final" })
  );
  expect(control("bloomStrength").disabled).toBe(true);
  expect(
    container.querySelector<HTMLOptionElement>(
      'select[name="stage"] option[value="bloom"]'
    )?.disabled
  ).toBe(true);
  await act(() => control("bloom").click());
  expect(control("bloomStrength").disabled).toBe(false);
});
it("explains unavailable indirect light instead of offering ineffective controls", async () => {
  await mount();
  expect(control("globalIllumination").disabled).toBe(true);
  expect(control("giIntensity").disabled).toBe(true);
  expect(
    container.querySelector<HTMLOptionElement>(
      'select[name="stage"] option[value="indirect"]'
    )?.disabled
  ).toBe(true);
  expect(container.textContent).toContain("Unavailable in the top-down chart");
});
