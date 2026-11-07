// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  DeveloperSettingsSection,
  renderStatusText,
} from "../../src/web/ui/developer-settings";
import type { MapHandle, RenderStatus } from "../../src/web/view/map-contract";

it("polls the renderer's status and composition, and publishes a changed failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let status: RenderStatus = {
    adapted: false,
    backend: "webgpu",
    failure: null,
    frameMs: 3.2,
    globalIlluminationAvailable: false,
    postProcessing: true,
    quality: "high",
  };
  const getRenderStatus = vi.fn(() => status);
  const describe = vi.fn(() => []);
  const scene: { current: MapHandle | null } = {
    current: { describe, focus: vi.fn(), getRenderStatus, zoom: vi.fn() },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(createElement(DeveloperSettingsSection, { scene }))
    );
    expect(getRenderStatus).toHaveBeenCalled();
    expect(describe).toHaveBeenCalled();
    expect(container.textContent).toContain("WebGPU");
    expect(container.textContent).toContain("3.2 ms per frame on the GPU");
    status = { ...status, failure: "The GPU connection was lost." };
    await act(() => vi.advanceTimersByTime(150));
    expect(container.textContent).toContain("The GPU connection was lost.");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("says when the map has given no status, and when the device has no GPU timings", () => {
  expect(renderStatusText(null)).toBe("Waiting for the map…");
  expect(
    renderStatusText({
      adapted: false,
      backend: "webgpu",
      failure: null,
      frameMs: null,
      globalIlluminationAvailable: false,
      postProcessing: true,
      quality: "high",
    })
  ).toBe("WebGPU · no GPU timings");
});
