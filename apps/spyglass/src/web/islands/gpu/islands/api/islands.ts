import {
  type Frame,
  type FrameLoopHandle,
  frameLoop,
  type Gpu,
  init,
  surface,
  type Timer,
  timer,
} from "vgpu";
import type { Chart, Point } from "../../../data/chart";
import { defaultValues } from "../../../lab/params";
import { type HeightRules, heightAt as heightOf } from "../land/height-at";
import { packCoasts, placeholderColors } from "../maps/map-data";
import { createMaps, type Maps } from "../maps/maps";
import { type IslandsSettings, islandsParams } from "../params";
import { animates, lookOf, mapParamsOf } from "../scene/look";
import { createScene, type Scene, type SceneTimers } from "../scene/scene";
import { type Banks, banksOf } from "../sea/banks";
import { seaDepthsOf } from "../sea/sea-params";
import debrisPlaceShader from "../shaders/land/debris/place.wgsl";
import debrisPropsShader from "../shaders/land/debris/props.wgsl";
import terrainShader from "../shaders/land/terrain.wgsl";
import coastsShader from "../shaders/maps/coasts.wgsl";
import coverageShader from "../shaders/maps/coverage.wgsl";
import distanceShader from "../shaders/maps/distance.wgsl";
import downsampleShader from "../shaders/maps/downsample.wgsl";
import filesShader from "../shaders/maps/files.wgsl";
import flowShader from "../shaders/maps/flow.wgsl";
import heightShader from "../shaders/maps/height.wgsl";
import lightShader from "../shaders/maps/light.wgsl";
import paintShader from "../shaders/maps/paint.wgsl";
import seabedShader from "../shaders/maps/seabed.wgsl";
import zoningShader from "../shaders/maps/zoning.wgsl";
import postAntialiasShader from "../shaders/post/antialias.wgsl";
import postBloomShader from "../shaders/post/bloom.wgsl";
import postFinishShader from "../shaders/post/finish.wgsl";
import waterShader from "../shaders/scene/water.wgsl";
import pickShader from "../shaders/view/pick.wgsl";
import selectionPrepareShader from "../shaders/view/selection-prepare.wgsl";
import selectionResolveShader from "../shaders/view/selection-resolve.wgsl";
import foliageShader from "../shaders/world/foliage.wgsl";
import foliageScatterShader from "../shaders/world/foliage-scatter.wgsl";
import surfacesShader from "../shaders/world/surfaces.wgsl";
import townShader from "../shaders/world/town.wgsl";
import townFloorsShader from "../shaders/world/town-floors.wgsl";
import { type BuildingIndex, buildingIndex } from "../view/building-at";
import {
  createOrbitControls,
  fit,
  frameOrbit,
  type Orbit,
  pixelsPerUnitAt,
  projectView,
  viewOf,
} from "../view/camera";
import { framedOf } from "../view/framing";
import { focusableFor } from "../view/keys";
import { createPicker } from "../view/pick";
import { chosenOf, type Described, memberMasks } from "../view/selection";
import {
  createSelectionController,
  type SelectionController,
} from "../view/selection-controller";
import { planWorld } from "../world/world-plan";
import type {
  Islands,
  IslandsControls,
  IslandsError,
  IslandsEvent,
  IslandsEvents,
  IslandsFrameOptions,
  IslandsOptions,
  IslandsStats,
} from "./types";

export const DEFAULT_ISLANDS_SETTINGS: IslandsSettings =
  defaultValues(islandsParams);

const STATS_INTERVAL = 250;

const UNFITTED: Orbit = {
  distance: 1000,
  pitch: 1,
  target: [0, 0, 0],
  yaw: 0,
};

const sameDescribed = (a: Described | null, b: Described | null) =>
  a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id;

const sameSettings = (a: IslandsSettings, b: IslandsSettings) =>
  (Object.keys(a) as (keyof IslandsSettings)[]).every(
    (key) => a[key] === b[key]
  );

type Listeners = {
  [E in IslandsEvent]: Set<(value: IslandsEvents[E]) => void>;
};

interface Running {
  select: (id: string | null) => boolean;
  setChart: (chart: Chart) => void;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;

const kindOf = (error: unknown, kind: IslandsError["kind"]): IslandsError => ({
  error,
  kind,
});

export function createIslands(
  canvas: HTMLCanvasElement,
  options: IslandsOptions
): Islands {
  const { debug } = options;
  let disposed = false;
  let controlled: IslandsControls = { ...options.controls };
  let gpu: Gpu | undefined;
  let loop: FrameLoopHandle | undefined;
  let scene: Scene | undefined;
  let maps: Maps | undefined;
  let gpuTimer: Timer | undefined;
  let selection: SelectionController | undefined;
  let running: Running | undefined;
  let given = options.chart;
  let drawn: Chart | null = null;
  let buildings: BuildingIndex | null = null;
  let wanted: IslandsSettings = {
    ...DEFAULT_ISLANDS_SETTINGS,
    ...options.settings,
  };
  let placed = options.view !== undefined;
  let choice: string | null | undefined;
  const listeners: Listeners = {
    error: new Set(),
    frame: new Set(),
    hover: new Set(),
    select: new Set(),
    stats: new Set(),
  };
  const emit = <E extends IslandsEvent>(event: E, value: IslandsEvents[E]) => {
    for (const listener of listeners[event]) {
      listener(value);
    }
  };
  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const controls = createOrbitControls(
    canvas,
    options.view ?? UNFITTED,
    () => ({ aspect: aspect(), chart: drawn }),
    controlled
  );
  let unfocusable = focusableFor(canvas, controlled.keyboard ?? "window");
  let banked: { banks: Banks; chart: Chart } | null = null;
  const banksFor = (chart: Chart): Banks => {
    if (banked?.chart !== chart) {
      banked = { banks: banksOf(chart), chart };
    }
    return banked.banks;
  };
  const raise = (failure: IslandsError) => {
    if (disposed) {
      return;
    }
    if (listeners.error.size === 0) {
      reportError(failure.error);
      return;
    }
    emit("error", failure);
  };
  const fail = (error: unknown) => raise(kindOf(error, "runtime"));

  const start = async () => {
    let device: Gpu;
    try {
      device = await init({ requiredFeatures: ["timestamp-query"] }).catch(() =>
        init()
      );
    } catch (error) {
      raise(kindOf(error, "unsupported"));
      return;
    }
    gpu = device;
    if (disposed) {
      device.dispose();
      return;
    }
    device.onError(fail);
    device.lost.then((lost) =>
      raise(
        kindOf(
          new Error(
            "The GPU connection was lost. Reload to redraw the chart.",
            {
              cause: lost,
            }
          ),
          "lost"
        )
      )
    );
    const output = surface(device, canvas, { dpr: [1, 2] });
    const gpuScene = createScene(device, {
      debrisPlace: debrisPlaceShader,
      debrisProps: debrisPropsShader,
      foliage: foliageShader,
      foliageScatter: foliageScatterShader,
      postAntialias: postAntialiasShader,
      postBloom: postBloomShader,
      postFinish: postFinishShader,
      selectionPrepare: selectionPrepareShader,
      selectionResolve: selectionResolveShader,
      surfaces: surfacesShader,
      terrain: terrainShader,
      town: townShader,
      townFloors: townFloorsShader,
      water: waterShader,
    });
    scene = gpuScene;
    const chartMaps = createMaps(device, {
      coasts: coastsShader,
      coverage: coverageShader,
      distance: distanceShader,
      downsample: downsampleShader,
      files: filesShader,
      flow: flowShader,
      height: heightShader,
      light: lightShader,
      paint: paintShader,
      seabed: seabedShader,
      zoning: zoningShader,
    });
    maps = chartMaps;
    await gpuScene.compile(output);
    if (disposed) {
      return;
    }
    let chart = given;
    drawn = chart;
    const plan = (next: Chart) => {
      const planned = performance.now();
      const world = planWorld(next);
      buildings = buildingIndex(next, world);
      debug?.time("planWorld", performance.now() - planned);
      gpuScene.setWorld(world);
      chartMaps.setWorld(world);
    };
    plan(chart);
    let banks: Banks = banksFor(chart);
    if (!placed) {
      controls.set(fit(chart, aspect()));
    }

    let stats: IslandsStats = {
      buildMs: null,
      depths: null,
      frameMs: null,
      hovered: null,
      islands: chart.islands.length,
      levels: banks.levels,
      mapMs: {},
      rebuilt: [],
      segments: packCoasts(chart).segmentCount,
      selected: null,
      terrainMs: null,
      texels: 0,
      waterMs: null,
    };
    let statsAt = 0;
    let frameMs: number | null = null;
    const publish = (next: Partial<IslandsStats>) => {
      stats = { ...stats, frameMs, ...next };
      emit("stats", stats);
    };

    let spans: SceneTimers = {};
    if (device.device.features.has("timestamp-query")) {
      gpuTimer = timer(device);
      spans = {
        terrain: gpuTimer.span("terrain"),
        water: gpuTimer.span("water"),
      };
      gpuTimer.onResults((times) => {
        const now = performance.now();
        if (now - statsAt < STATS_INTERVAL) {
          return;
        }
        statsAt = now;
        publish({
          terrainMs: times.terrain ?? null,
          waterMs: times.water ?? null,
        });
      });
    }

    const rebuild = (next: IslandsSettings): boolean => {
      const params = mapParamsOf(next);
      const report = chartMaps.build(chart, params);
      if (report.rebuilt.length === 0) {
        return false;
      }
      if (report.rebuilt.includes("paint")) {
        gpuScene.setIslandColors(placeholderColors(chart, params.palette));
      }
      publish({
        buildMs: null,
        depths: seaDepthsOf(params, banks.levels),
        mapMs: { ...stats.mapMs, ...report.ms },
        rebuilt: report.rebuilt,
        texels: chartMaps.frame.resolution,
      });
      report.settled
        .then((ms) => {
          if (!disposed) {
            publish({ buildMs: ms });
          }
        })
        .catch(fail);
      return true;
    };

    let settings = wanted;
    rebuild(settings);
    let dirty = true;

    const gpuPicker = createPicker(device, pickShader, gpuScene.film);
    gpuScene.setSelection(gpuPicker.selection, memberMasks(banks));
    const selectionController = createSelectionController(canvas, gpuPicker, {
      banks,
      buildings: () => buildings,
      chart,
      enabled: settings.selection,
      keyboard: controlled.keyboard ?? "window",
      onChange: (next) => {
        const chose = !sameDescribed(stats.selected, next.selected);
        const hovered = !sameDescribed(stats.hovered, next.hovered);
        publish(next);
        if (chose) {
          emit("select", next.selected);
        }
        if (hovered) {
          emit("hover", next.hovered);
        }
      },
      onDirty: () => {
        dirty = true;
      },
      onError: fail,
      pixelsPerUnit: (at) =>
        pixelsPerUnitAt(
          viewOf(controls.orbit, aspect()),
          [at[0], heightAt(at), at[1]],
          canvas.clientHeight
        ),
    });
    selection = selectionController;
    output.onResize(() => {
      dirty = true;
    });
    let waveTime = 0;
    let last = performance.now();

    const select = (id: string | null) =>
      selectionController.choose(
        id === null
          ? null
          : chosenOf(chart, banks, id, (building) => buildings?.byId(building))
      );
    const replace = (next: Chart) => {
      if (next === chart) {
        return;
      }
      const kept = stats.selected?.id ?? null;
      chart = next;
      drawn = next;
      plan(next);
      banks = banksFor(next);
      gpuScene.setSelection(gpuPicker.selection, memberMasks(banks));
      selectionController.setChart(next, banks);
      publish({
        islands: next.islands.length,
        levels: banks.levels,
        segments: packCoasts(next).segmentCount,
      });
      rebuild(settings);
      dirty = true;
      if (kept !== null) {
        select(kept);
      }
    };
    running = {
      select,
      setChart(next) {
        queueMicrotask(() => {
          if (disposed || given !== next) {
            return;
          }
          try {
            replace(next);
          } catch (error) {
            fail(error);
          }
        });
      },
    };
    if (choice !== undefined) {
      select(choice);
    }

    const tick = (frame: Frame) => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const next = wanted;
      if (next !== settings) {
        settings = next;
        dirty = true;
        selectionController.setEnabled(next.selection);
        queueMicrotask(() => {
          if (disposed || settings !== next) {
            return;
          }
          try {
            dirty = rebuild(next) || dirty;
          } catch (error) {
            fail(error);
          }
        });
      }
      const moved = controls.update(dt);
      const moving = animates(lookOf(settings, banks, waveTime));
      if (moving) {
        waveTime += dt * settings.waveSpeed;
      }
      if (!(dirty || moved || moving)) {
        frame.cancel();
        return;
      }
      dirty = false;
      const view = viewOf(controls.orbit, output.size[0] / output.size[1]);
      selectionController.encode(frame, view, chartMaps);
      gpuScene.render(
        frame,
        output,
        view,
        chartMaps,
        lookOf(settings, banks, waveTime),
        spans
      );
      frame.submit();
      const cpuMs = performance.now() - now;
      frameMs = cpuMs;
      if (!gpuTimer && now - statsAt >= STATS_INTERVAL) {
        statsAt = now;
        publish({});
      }
      emit("frame", { cpuMs });
    };

    loop = frameLoop(device, (frame) => {
      try {
        tick(frame);
      } catch (error) {
        fail(error);
        throw error;
      }
    });
  };

  start().catch(fail);

  const current = () => drawn ?? given;
  let ruled: {
    banks: Banks;
    rules: HeightRules;
    settings: IslandsSettings;
  } | null = null;
  const heightRules = (): HeightRules => {
    const banks = banksFor(current());
    if (ruled?.settings !== wanted || ruled.banks !== banks) {
      const params = mapParamsOf(wanted);
      const seaTop = seaDepthsOf(params, banks.levels).top;
      ruled = { banks, rules: { ...params, seaTop }, settings: wanted };
    }
    return ruled.rules;
  };
  const heightAt = (point: Point) => heightOf(current(), heightRules(), point);
  const moduleAt = (id: string): Point | null => {
    const building = buildings?.ofModule(id);
    if (building) {
      return building.at;
    }
    return current().modules.find((module) => module.id === id)?.at ?? null;
  };
  const frameTarget = (
    target: string | null,
    frameOptions?: IslandsFrameOptions
  ) => {
    const chart = current();
    let to: Orbit;
    if (target === null) {
      to = fit(chart, aspect());
    } else {
      const framed = framedOf(
        chart,
        banksFor(chart),
        target,
        (id) => moduleAt(id) ?? undefined
      );
      if (!framed) {
        return;
      }
      to = frameOrbit(controls.orbit, framed.centre, framed.radius, aspect());
    }
    placed = true;
    const reduced = controlled.reducedMotion ?? prefersReducedMotion();
    if (frameOptions?.animate === false || reduced) {
      controls.set(to);
    } else {
      controls.fly(to);
    }
  };

  return {
    dispose() {
      disposed = true;
      loop?.stop();
      controls.dispose();
      unfocusable();
      selection?.dispose();
      gpuTimer?.dispose();
      scene?.dispose();
      maps?.dispose();
      gpu?.dispose();
      for (const set of Object.values(listeners)) {
        set.clear();
      }
    },
    fit() {
      placed = true;
      controls.set(fit(current(), aspect()));
    },
    frame: frameTarget,
    heightAt,
    moduleAt,
    on(event, listener) {
      const set = listeners[event] as Set<typeof listener>;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    pixelsPerUnit(at) {
      const tall = canvas.clientHeight;
      const view = viewOf(controls.orbit, aspect());
      const point = at
        ? ([at[0], heightAt(at), at[1]] as const)
        : controls.orbit.target;
      return pixelsPerUnitAt(view, point, tall);
    },
    project([x, y], height = 0) {
      const width = canvas.clientWidth;
      const tall = canvas.clientHeight;
      const view = viewOf(controls.orbit, width / Math.max(1, tall));
      return projectView(view, [x, height, y], width, tall);
    },
    select(id) {
      let changed = true;
      if (running) {
        changed = running.select(id);
      } else {
        choice = id;
      }
      const chart = current();
      if (
        changed &&
        id !== null &&
        chart.modules.some((module) => module.id === id)
      ) {
        frameTarget(id);
      }
    },
    setChart(chart) {
      given = chart;
      running?.setChart(chart);
    },
    setControls(next) {
      const keyboard = controlled.keyboard ?? "window";
      controlled = { ...controlled, ...next };
      controls.configure(next);
      if (next.keyboard !== undefined && next.keyboard !== keyboard) {
        unfocusable();
        unfocusable = focusableFor(canvas, next.keyboard);
        selection?.setKeyboard(next.keyboard);
      }
    },
    setSettings(next) {
      const merged = { ...wanted, ...next };
      if (!sameSettings(merged, wanted)) {
        wanted = merged;
      }
    },
    setView(view) {
      placed = true;
      controls.set(view);
    },
    get view() {
      return controls.orbit;
    },
  };
}
