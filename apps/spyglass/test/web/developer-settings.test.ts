// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { RenderStatus } from "../../src/web/scene/pipeline";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { DeveloperSettingsSection } from "../../src/web/ui/developer-settings";
import type { SpyglassMapHandle } from "../../src/web/ui/spyglass-map";

it("polls only the active diagnostics tab and publishes a changed pipeline failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let status: RenderStatus = {
    adapted: false,
    backend: "webgl",
    failure: null,
    frameMs: null,
    globalIlluminationAvailable: false,
    postProcessing: false,
    quality: "medium",
  };
  const getRenderStatus = vi.fn(() => status);
  const describe = vi.fn(() => []);
  const scene: { current: SpyglassMapHandle | null } = {
    current: {
      describe,
      focus: vi.fn(),
      focusWreck: vi.fn(),
      getRenderStatus,
      zoom: vi.fn(),
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = async (section: "layers" | "rendering" | "stats") => {
    await act(() =>
      root.render(
        createElement(DeveloperSettingsSection, {
          disabled: false,
          layoutPending: false,
          onChange: vi.fn(),
          scene,
          section,
          settings: defaultChartSettings,
        })
      )
    );
  };
  try {
    await show("layers");
    await act(() => vi.advanceTimersByTime(600));
    expect(getRenderStatus).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
    await show("rendering");
    expect(getRenderStatus).toHaveBeenCalledOnce();
    status = { ...status, failure: "shader rejected" };
    await act(() => vi.advanceTimersByTime(150));
    expect(container.textContent).toContain("shader rejected");
    await show("layers");
    const reads = getRenderStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTime(600));
    expect(getRenderStatus).toHaveBeenCalledTimes(reads);
    await show("stats");
    expect(describe).toHaveBeenCalledOnce();
    await show("layers");
    await act(() => vi.advanceTimersByTime(600));
    expect(describe).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
