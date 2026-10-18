import { Mesh, OrthographicCamera, PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";

// No GPU backend exists here, so the pass graph's render is stubbed: it
// throws like a failed compile by default and succeeds for the adaptive test.
const stub = vi.hoisted(() => ({
  aoCalls: 0,
  disposed: 0,
  outputs: [] as unknown[],
  throwOnRender: true,
}));
vi.mock("three/webgpu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three/webgpu")>()),
  RenderPipeline: class {
    outputColorTransform = true;
    set outputNode(node: unknown) {
      stub.outputs.push(node);
    }
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

vi.mock("three/addons/tsl/display/GTAONode.js", async (importOriginal) => {
  const module =
    await importOriginal<
      typeof import("three/addons/tsl/display/GTAONode.js")
    >();
  return {
    ...module,
    ao: (...args: Parameters<typeof module.ao>) => {
      stub.aoCalls += 1;
      return module.ao(...args);
    },
  };
});

/** Lets the measurement microtasks after a render settle. */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
};

import { vec4 } from "three/tsl";
import { createRenderPipeline } from "../../src/web/scene/pipeline";
import type { Stage } from "../../src/web/scene/stages/stage";
import { defaultRenderSettings } from "../../src/web/settings/chart-settings";

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

it("drains timestamp queries during direct rendering so the GPU query pool cannot fill", async () => {
  const resolveTimestampsAsync = vi.fn(() => Promise.resolve());
  const renderer = {
    backend: {},
    info: { render: { timestamp: 5 } },
    render: vi.fn(),
    resolveTimestampsAsync,
  } as unknown as Parameters<typeof createRenderPipeline>[0]["renderer"];
  const pipeline = createRenderPipeline({
    camera: new OrthographicCamera(),
    renderer,
    scene: new Scene(),
  });
  try {
    pipeline.configure({ ...defaultRenderSettings, quality: "off" });
    await pipeline.ready();
    for (let frame = 0; frame < 60; frame += 1) {
      pipeline.render();
      await settle();
    }
    expect(resolveTimestampsAsync).toHaveBeenCalledTimes(60);
    expect(pipeline.status().postProcessing).toBe(false);
  } finally {
    pipeline.dispose();
  }
});

it("uses engraved chart relief in Light while retaining screen-space occlusion for its preview and wreck views", async () => {
  const options = {
    renderer: fakeRenderer(),
    scene: new Scene(),
  };
  const chart = createRenderPipeline({
    ...options,
    camera: new OrthographicCamera(),
  });
  const wreck = createRenderPipeline({
    ...options,
    camera: new PerspectiveCamera(),
  });
  const before = stub.aoCalls;
  try {
    chart.configure({ ...defaultRenderSettings, quality: "low" });
    await chart.ready();
    expect(stub.aoCalls).toBe(before);
    chart.configure({
      ...defaultRenderSettings,
      quality: "low",
      stage: "occlusion",
    });
    await chart.ready();
    expect(stub.aoCalls).toBe(before + 1);
    wreck.configure({ ...defaultRenderSettings, quality: "low" });
    await wreck.ready();
    expect(stub.aoCalls).toBe(before + 2);
  } finally {
    chart.dispose();
    wreck.dispose();
  }
});

describe("the composer over fake stages", () => {
  const camera = new OrthographicCamera();
  /** A stage that records when it is applied and answers with a view of its own. */
  const fakeStage = (
    id: Stage["id"],
    needs: Stage["needs"],
    applied: string[],
    load: Stage["load"] = () => Promise.resolve({ id })
  ): Stage => ({
    apply(frame) {
      applied.push(id);
      frame.color = vec4(frame.color.rgb, 1);
      return vec4(id === "final" ? 1 : 0, 0, 0, 1);
    },
    id,
    label: id,
    load,
    needs,
  });

  it("builds the stages the settings need, in the registry's order, and reports which are in the graph", async () => {
    const applied: string[] = [];
    const stages = [
      fakeStage("occlusion", (settings) => settings.ambientOcclusion, applied),
      fakeStage("bloom", (settings) => settings.bloom, applied),
      fakeStage("final", () => true, applied),
    ];
    const pipeline = createRenderPipeline({
      camera,
      renderer: fakeRenderer(),
      scene: new Scene(),
      stages,
    });
    try {
      pipeline.configure({ ...defaultRenderSettings, bloom: false });
      expect(pipeline.stages().map((stage) => stage.enabled)).toEqual([
        false,
        false,
        false,
      ]);
      await pipeline.ready();
      expect(applied).toEqual(["occlusion", "final"]);
      expect(pipeline.stages()).toEqual([
        { enabled: true, id: "occlusion", label: "occlusion" },
        { enabled: false, id: "bloom", label: "bloom" },
        { enabled: true, id: "final", label: "final" },
      ]);
      // A toggle changes the structure, so the graph is built again, in order.
      pipeline.configure({ ...defaultRenderSettings, bloom: true });
      await pipeline.ready();
      expect(applied).toEqual([
        "occlusion",
        "final",
        "occlusion",
        "bloom",
        "final",
      ]);
      expect(
        pipeline
          .stages()
          .filter((stage) => stage.enabled)
          .map((s) => s.id)
      ).toEqual(["occlusion", "bloom", "final"]);
    } finally {
      pipeline.dispose();
    }
  });

  it("shows the stage the settings name in place of the finished image, and the depth as its own view", async () => {
    const applied: string[] = [];
    const bloomStage = fakeStage("bloom", () => true, applied);
    const finalStage = fakeStage("final", () => true, applied);
    const views: unknown[] = [];
    const spyBloom = vi.spyOn(bloomStage, "apply");
    const spyFinal = vi.spyOn(finalStage, "apply");
    const pipeline = createRenderPipeline({
      camera,
      renderer: fakeRenderer(),
      scene: new Scene(),
      stages: [bloomStage, finalStage],
    });
    try {
      stub.outputs.length = 0;
      pipeline.configure({ ...defaultRenderSettings, stage: "bloom" });
      await pipeline.ready();
      views.push(stub.outputs.at(-1));
      expect(views[0]).toBe(spyBloom.mock.results[0]?.value);
      pipeline.configure({ ...defaultRenderSettings, stage: "final" });
      await pipeline.ready();
      expect(stub.outputs.at(-1)).toBe(spyFinal.mock.results[1]?.value);
      pipeline.configure({ ...defaultRenderSettings, stage: "depth" });
      await pipeline.ready();
      const depth = stub.outputs.at(-1);
      expect(depth).not.toBe(spyBloom.mock.results[2]?.value);
      expect(depth).not.toBe(spyFinal.mock.results[2]?.value);
      expect(depth).toBeDefined();
    } finally {
      pipeline.dispose();
    }
  });

  it("refills the frame's selection from the provider before each render without rebuilding the graph", async () => {
    stub.throwOnRender = false;
    const applied: string[] = [];
    const selections: unknown[] = [];
    const seen: Stage = {
      ...fakeStage("outline", () => true, applied),
      apply(frame) {
        selections.push(frame.selection);
        return vec4(0, 0, 0, 1);
      },
    };
    const island = [new Mesh(), new Mesh()];
    let selected: Mesh[] = [];
    const selectedObjects = vi.fn(() => selected);
    let builds = 0;
    const pipeline = createRenderPipeline({
      camera,
      onStatus: () => {
        builds += 1;
      },
      renderer: fakeRenderer(),
      scene: new Scene(),
      selectedObjects,
      stages: [seen, fakeStage("final", () => true, applied)],
    });
    try {
      pipeline.configure(defaultRenderSettings);
      await pipeline.ready();
      const before = pipeline.stages();
      // The stage keeps the one array the composer refills before each render.
      const [selection] = selections as { length: number }[];
      expect(selection).toEqual([]);
      pipeline.render();
      expect(selectedObjects).toHaveBeenCalledTimes(1);
      expect(selection).toEqual([]);
      selected = island;
      pipeline.render();
      expect(selectedObjects).toHaveBeenCalledTimes(2);
      expect(selection).toEqual(island);
      expect(selections[0]).toBe(selection);
      selected = [];
      pipeline.render();
      expect(selection).toEqual([]);
      // Selecting is not a change of structure: the same graph, once built.
      pipeline.configure(defaultRenderSettings);
      await pipeline.ready();
      expect(builds).toBe(1);
      expect(applied).toEqual(["final"]);
      expect(selections).toHaveLength(1);
      expect(pipeline.stages()).toEqual(before);
    } finally {
      stub.throwOnRender = true;
      pipeline.dispose();
    }
  });

  it("draws directly, and says why, when a stage fails to load or to apply", async () => {
    const applied: string[] = [];
    const renderer = fakeRenderer();
    const pipeline = createRenderPipeline({
      camera,
      renderer,
      scene: new Scene(),
      stages: [
        fakeStage(
          "bloom",
          () => true,
          applied,
          () => Promise.reject(new Error("no module"))
        ),
        fakeStage("final", () => true, applied),
      ],
    });
    try {
      pipeline.configure(defaultRenderSettings);
      await pipeline.ready();
      expect(pipeline.status()).toMatchObject({
        failure: "no module",
        postProcessing: false,
      });
      expect(applied).toEqual([]);
      pipeline.render();
      expect(renderer.render).toHaveBeenCalledTimes(1);
    } finally {
      pipeline.dispose();
    }
    const broken: Stage = {
      ...fakeStage("occlusion", () => true, applied),
      apply() {
        throw new Error("cannot compile");
      },
    };
    const second = createRenderPipeline({
      camera,
      renderer,
      scene: new Scene(),
      stages: [broken, fakeStage("final", () => true, applied)],
    });
    try {
      second.configure(defaultRenderSettings);
      await second.ready();
      expect(second.status()).toMatchObject({
        failure: "cannot compile",
        postProcessing: false,
      });
      expect(second.stages().every((stage) => !stage.enabled)).toBe(true);
      second.render();
      expect(renderer.render).toHaveBeenCalledTimes(2);
    } finally {
      second.dispose();
    }
  });
});
