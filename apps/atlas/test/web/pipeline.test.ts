import { OrthographicCamera, PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";

// No GPU backend exists here, so the pass graph's render is stubbed: it
// throws like a failed compile by default and succeeds for the adaptive test.
const stub = vi.hoisted(() => ({ disposed: 0, throwOnRender: true }));
vi.mock("three/webgpu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three/webgpu")>()),
  RenderPipeline: class {
    outputColorTransform = true;
    outputNode: unknown = null;
    dispose() {
      stub.disposed += 1;
    }
    render() {
      if (stub.throwOnRender) {
        throw new Error("no backend");
      }
    }
  },
}));

/** Lets the measurement microtasks after a render settle. */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
};

import { defaultRenderSettings } from "../../src/web/chart-settings";
import { createRenderPipeline } from "../../src/web/scene/pipeline";

function fakeRenderer(webgpu = false) {
  return {
    backend: webgpu ? { isWebGPUBackend: true } : {},
    render: vi.fn(),
  } as unknown as Parameters<typeof createRenderPipeline>[0]["renderer"];
}

describe("render pipeline", () => {
  it("draws directly when quality is off and reports the backend", async () => {
    const renderer = fakeRenderer(true);
    const pipeline = createRenderPipeline({
      camera: new OrthographicCamera(),
      filter: () => "original",
      renderer,
      scene: new Scene(),
    });
    pipeline.configure({ ...defaultRenderSettings, quality: "off" });
    await pipeline.ready();
    expect(pipeline.status()).toEqual({
      adapted: false,
      backend: "webgpu",
      failure: null,
      frameMs: null,
      globalIlluminationAvailable: false,
      postProcessing: false,
      quality: "off",
    });
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    pipeline.dispose();
  });

  it("builds a pass graph and falls back to a direct draw when it cannot render", async () => {
    const renderer = fakeRenderer();
    const statuses: boolean[] = [];
    const pipeline = createRenderPipeline({
      camera: new PerspectiveCamera(),
      filter: () => "treasure",
      onStatus: (status) => statuses.push(status.postProcessing),
      renderer,
      scene: new Scene(),
    });
    pipeline.configure(defaultRenderSettings);
    // Stages are still loading: the frame draws directly without a status flip.
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([]);
    await pipeline.ready();
    expect(pipeline.status()).toMatchObject({
      backend: "webgl",
      globalIlluminationAvailable: true,
      postProcessing: true,
      quality: "medium",
    });
    // No backend is initialized here, so the graph throws; the chart must
    // still draw and the status must say so.
    pipeline.render();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(pipeline.status().postProcessing).toBe(false);
    expect(statuses).toEqual([true, false]);
    pipeline.dispose();
  });

  it("only rebuilds the graph when structure changes", async () => {
    const renderer = fakeRenderer();
    let rebuilds = 0;
    const pipeline = createRenderPipeline({
      camera: new PerspectiveCamera(),
      filter: () => "original",
      onStatus: () => {
        rebuilds += 1;
      },
      renderer,
      scene: new Scene(),
    });
    pipeline.configure({ ...defaultRenderSettings, globalIllumination: true });
    await pipeline.ready();
    // Sliders are uniforms: no rebuild for exposure, bloom, or reach changes.
    pipeline.configure({
      ...defaultRenderSettings,
      aoReach: 30,
      bloomStrength: 1,
      exposure: 1.4,
      globalIllumination: true,
    });
    await pipeline.ready();
    expect(rebuilds).toBe(1);
    pipeline.configure({ ...defaultRenderSettings, bloom: false });
    await pipeline.ready();
    expect(rebuilds).toBe(2);
    pipeline.configure({
      ...defaultRenderSettings,
      bloom: false,
      stage: "depth",
    });
    await pipeline.ready();
    expect(rebuilds).toBe(3);
    pipeline.dispose();
  });

  it("steps the tier down when frames run over budget until a quality is chosen", async () => {
    stub.throwOnRender = false;
    const renderer = {
      backend: {},
      info: { render: { timestamp: 60 } },
      render: vi.fn(),
      resolveTimestampsAsync: vi.fn(() => Promise.resolve(60)),
    } as unknown as Parameters<typeof createRenderPipeline>[0]["renderer"];
    const qualities: string[] = [];
    const pipeline = createRenderPipeline({
      camera: new PerspectiveCamera(),
      filter: () => "original",
      onStatus: (status) => qualities.push(status.quality),
      renderer,
      scene: new Scene(),
    });
    try {
      pipeline.configure({ ...defaultRenderSettings, quality: "high" });
      await pipeline.ready();
      expect(qualities).toEqual(["high"]);
      for (let i = 0; i < 30; i += 1) {
        pipeline.render();
        await settle();
      }
      await pipeline.ready();
      expect(pipeline.status()).toMatchObject({
        adapted: true,
        postProcessing: true,
        quality: "medium",
      });
      expect(pipeline.status().frameMs).toBeCloseTo(60, 5);
      // The cap only lowers the setting; a lower setting stands on its own.
      pipeline.configure({ ...defaultRenderSettings, quality: "low" });
      await pipeline.ready();
      expect(pipeline.status()).toMatchObject({
        adapted: false,
        quality: "low",
      });
      // Choosing a tier again is an explicit decision that clears the cap.
      pipeline.configure({ ...defaultRenderSettings, quality: "high" });
      await pipeline.ready();
      expect(pipeline.status().quality).toBe("high");
    } finally {
      stub.throwOnRender = true;
      pipeline.dispose();
    }
  });
});
