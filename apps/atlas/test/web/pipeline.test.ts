import { OrthographicCamera, PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
import { defaultRenderSettings } from "../../src/web/chart-settings";
import { createRenderPipeline } from "../../src/web/scene/pipeline";

function fakeRenderer(webgpu = false) {
  return {
    backend: webgpu ? { isWebGPUBackend: true } : {},
    render: vi.fn(),
  } as unknown as Parameters<typeof createRenderPipeline>[0];
}

describe("render pipeline", () => {
  it("draws directly when quality is off and reports the backend", () => {
    const renderer = fakeRenderer(true);
    const pipeline = createRenderPipeline(
      renderer,
      new Scene(),
      new OrthographicCamera(),
      () => "original"
    );
    pipeline.configure({ ...defaultRenderSettings, quality: "off" });
    expect(pipeline.status()).toEqual({
      backend: "webgpu",
      globalIlluminationAvailable: false,
      postProcessing: false,
    });
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    pipeline.dispose();
  });

  it("builds a pass graph and falls back to a direct draw when it cannot render", () => {
    const renderer = fakeRenderer();
    const statuses: boolean[] = [];
    const pipeline = createRenderPipeline(
      renderer,
      new Scene(),
      new PerspectiveCamera(),
      () => "treasure",
      undefined,
      (status) => statuses.push(status.postProcessing)
    );
    pipeline.configure(defaultRenderSettings);
    expect(pipeline.status()).toEqual({
      backend: "webgl",
      globalIlluminationAvailable: true,
      postProcessing: true,
    });
    // No backend is initialized here, so the graph throws; the chart must
    // still draw and the status must say so.
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(pipeline.status().postProcessing).toBe(false);
    expect(statuses).toEqual([true, false]);
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    pipeline.dispose();
  });

  it("only rebuilds the graph when structure changes", () => {
    const renderer = fakeRenderer();
    let rebuilds = 0;
    const pipeline = createRenderPipeline(
      renderer,
      new Scene(),
      new PerspectiveCamera(),
      () => "original",
      undefined,
      () => {
        rebuilds += 1;
      }
    );
    pipeline.configure({ ...defaultRenderSettings, globalIllumination: true });
    pipeline.configure({
      ...defaultRenderSettings,
      exposure: 1.4,
      globalIllumination: true,
    });
    expect(rebuilds).toBe(1);
    pipeline.configure({ ...defaultRenderSettings, bloom: false });
    expect(rebuilds).toBe(2);
    pipeline.dispose();
  });
});
