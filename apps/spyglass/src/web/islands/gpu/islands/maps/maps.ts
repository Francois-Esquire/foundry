import {
  type Compute,
  compute,
  type Draw,
  draw,
  type Effect,
  effect,
  type Frame,
  frame,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  sampler,
  storage,
  type Target,
  type Texture,
  texture,
} from "vgpu";
import type { Chart } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import { wordsPerBank } from "../view/selection";
import type { WorldPlan, ZoneKind } from "../world/world";
import {
  type PackedZoning,
  packZoning,
  ZONE_GROWTH,
  ZONE_ORDER,
} from "../world/zoning";
import { type BakeLayout, bakeLayout } from "./bake-layout";
import {
  type BankBuffers,
  heightBindings,
  heightWorkspace,
  releaseWorkspace,
} from "./height-bake";
import {
  packBanks,
  packCoasts,
  packModules,
  packPieces,
  placeholderColors,
} from "./map-data";
import {
  changedParams,
  MAP_NAMES,
  MAP_OF_PARAM,
  MAP_PASSES,
  type MapName,
  type MapParams,
  type MapPass,
  type MapPassName,
  passesWithDependants,
} from "./map-params";
import {
  filesUniforms,
  flowUniforms,
  frameUniform,
  lightUniforms,
  type MapFrame,
  mipLevelCount,
  paintUniforms,
  SEABED_RESOLUTION,
  seabedFrame,
  seabedUniforms,
  zoningUniforms,
} from "./map-uniforms";

export interface MapShaders {
  coasts: ShaderSource;
  coverage: ShaderSource;
  distance: ShaderSource;
  downsample: ShaderSource;
  files: ShaderSource;
  flow: ShaderSource;
  height: ShaderSource;
  light: ShaderSource;
  paint: ShaderSource;
  seabed: ShaderSource;
  zoning: ShaderSource;
}

const MAP_FORMATS = {
  coasts: "r16float",
  coverage: "r8unorm",
  distance: "rg16float",
  files: "rgba8unorm",
  flow: "rgba16float",
  footprints: "rgba32uint",
  height: "rgba16float",
  islands: "r32uint",
  light: "rgba16float",
  paint: "rgba8unorm",
  rings: "rgba16uint",
  seabed: "rgba16float",
  shade: "rgba8unorm",
  zoning: "rgba8unorm",
} as const satisfies Record<MapName, GPUTextureFormat>;

const MIPPED: ReadonlySet<MapName> = new Set<MapName>(["distance", "height"]);
const WRITTEN_BY_COMPUTE: ReadonlySet<MapName> = new Set<MapName>([
  "flow",
  "light",
  "shade",
  "paint",
]);

interface MapsReport {
  readonly ms: Partial<Record<MapName, number>>;
  readonly rebuilt: readonly MapName[];
  readonly settled: Promise<number>;
}

interface BakedSelection {
  readonly footprints: Texture;
  readonly wordsPerBank: number;
}

export interface MapSource {
  readonly frame: MapFrame;
  readonly seabed: MapFrame;
  readonly selection: BakedSelection | null;
  readonly textures: Readonly<Record<MapName, Texture>>;
}

export interface Maps extends MapSource {
  build: (chart: Chart, params: MapParams, into?: Frame) => MapsReport;
  dispose: () => void;
  readonly frame: MapFrame;
  setWorld: (plan: WorldPlan | null) => void;
  readonly textures: Readonly<Record<MapName, Texture>>;
}

const WORKGROUP = 8;

type PassOptions = Parameters<Target["renderPassDescriptor"]>[0];

function levelTarget(
  textures: readonly [Texture, ...Texture[]],
  level: number,
  layer = 0
): Target {
  const [first] = textures;
  const side = first.size[0] / 2 ** level;
  const size = [side, side] as const;
  return {
    clearColor: [0, 0, 0, 0],
    color: first,
    colors: textures,
    format: first.format,
    gpu: first,
    onDestroy: (cb) =>
      first.onDestroy(() => cb(levelTarget(textures, level, layer))),
    renderPassDescriptor: (opts?: PassOptions) => ({
      colorAttachments: textures.map((t) => ({
        loadOp: opts?.preserve ? "load" : "clear",
        storeOp: "store",
        view: t.createView({
          arrayLayerCount: 1,
          baseArrayLayer: layer,
          baseMipLevel: level,
          dimension: "2d",
          mipLevelCount: 1,
        }),
      })),
    }),
    resize() {
      throw new Error("A map level target has a fixed size");
    },
    resourceIdentity: first.resourceIdentity,
    sampleCount: 1,
    size,
    texelSize: [1 / side, 1 / side],
  };
}

interface Passes {
  readonly coasts: Effect;
  readonly coverage: Effect;
  readonly distance: Effect;
  readonly downsample: Readonly<Record<"distance" | "height", Effect[]>>;
  readonly files: Draw;
  readonly flow: Compute;
  readonly height: Draw;
  readonly key: string;
  readonly light: Compute;
  readonly paint: Compute;
  readonly seabed: Effect;
  readonly zoning: ZoningDraws;
}

interface ZoningDraws {
  readonly reserves: Draw;
  readonly rings: Draw;
  readonly roads: Draw;
  readonly zones: Readonly<Record<ZoneKind, Draw>>;
}

const passesKey = (layout: BakeLayout): string =>
  `${layout.frame.resolution}:${layout.scalable}:${layout.footprints}`;

function mapTextureDescriptor(name: MapName, layout: BakeLayout) {
  const { resolution } = layout.frame;
  const usage = (writer: "render_attachment" | "storage_binding") =>
    [writer, "texture_binding", "copy_src"] as const;
  if (name === "coasts") {
    const side = layout.coastResolution * layout.coastColumns;
    return {
      format: MAP_FORMATS.coasts,
      kind: "2d-array",
      layers: layout.coastLayers,
      mipLevelCount: 1,
      size: [side, side],
      usage: usage("render_attachment"),
    } as const;
  }
  if (name === "seabed") {
    return {
      format: MAP_FORMATS.seabed,
      kind: "2d",
      mipLevelCount: 1,
      size: [SEABED_RESOLUTION, SEABED_RESOLUTION],
      usage: usage("render_attachment"),
    } as const;
  }
  if (name === "footprints") {
    const side = layout.footprints ? resolution : 1;
    return {
      format: MAP_FORMATS.footprints,
      kind: "2d-array",
      layers: layout.footprints ? layout.footprintPages : 1,
      mipLevelCount: 1,
      size: [side, side],
      usage: usage("storage_binding"),
    } as const;
  }
  return {
    format: MAP_FORMATS[name],
    kind: "2d",
    mipLevelCount: MIPPED.has(name) ? mipLevelCount(resolution) : 1,
    size: [resolution, resolution],
    usage: usage(
      WRITTEN_BY_COMPUTE.has(name) ? "storage_binding" : "render_attachment"
    ),
  } as const;
}

function mergeTextures(
  before: Readonly<Record<MapName, Texture>> | undefined,
  rebuilt: Partial<Record<MapName, Texture>>
): Record<MapName, Texture> {
  const pick = (name: MapName): Texture => {
    const chosen = rebuilt[name] ?? before?.[name];
    if (!chosen) {
      throw new Error(`Map ${name} has never been built`);
    }
    return chosen;
  };
  return {
    coasts: pick("coasts"),
    coverage: pick("coverage"),
    distance: pick("distance"),
    files: pick("files"),
    flow: pick("flow"),
    footprints: pick("footprints"),
    height: pick("height"),
    islands: pick("islands"),
    light: pick("light"),
    paint: pick("paint"),
    rings: pick("rings"),
    seabed: pick("seabed"),
    shade: pick("shade"),
    zoning: pick("zoning"),
  };
}

const ZONE_BLEND = {
  alpha: { dst: "one-minus-src-alpha", src: "constant" },
  color: { dst: "one-minus-src-alpha", src: "one" },
} as const;
const RING_BLEND = {
  alpha: { dst: "one", op: "max", src: "one" },
  color: { dst: "one", op: "max", src: "one" },
} as const;
const RESERVE_BLEND = {
  alpha: { dst: "one-minus-src-alpha", src: "zero" },
  color: { dst: "one-minus-src-alpha", src: "one" },
} as const;

function createZoningDraws(gpu: Gpu, shader: ShaderSource): ZoningDraws {
  const polygons = (
    label: string,
    fragment: string,
    blend: typeof ZONE_BLEND | typeof RING_BLEND | typeof RESERVE_BLEND,
    blendConstant?: readonly [number, number, number, number]
  ) =>
    draw(gpu, {
      blend,
      blendConstant,
      entry: { fragment, vertex: "vs_polygon" },
      label: `islands-zoning-${label}`,
      shader,
      vertices: 6,
    });
  const zones = Object.fromEntries(
    ZONE_ORDER.map((kind) => {
      const { open } = ZONE_GROWTH[kind];
      return [
        kind,
        polygons(kind, "fs_zone", ZONE_BLEND, [open, open, open, open]),
      ];
    })
  ) as Record<ZoneKind, Draw>;
  return {
    reserves: polygons("reserves", "fs_reserve", RESERVE_BLEND),
    rings: polygons("rings", "fs_ring", RING_BLEND),
    roads: draw(gpu, {
      blend: RESERVE_BLEND,
      entry: { fragment: "fs_road", vertex: "vs_road" },
      label: "islands-zoning-roads",
      shader,
      vertices: 6,
    }),
    zones,
  };
}

export function createMaps(gpu: Gpu, shaders: MapShaders): Maps {
  let passes: Passes | undefined;
  let published: Record<MapName, Texture> | undefined;
  let last: { chart: Chart; layout: BakeLayout; params: MapParams } | undefined;
  let coastBuffers:
    | { chart: Chart; coasts: StorageBuffer; segments: StorageBuffer }
    | undefined;
  let pieceBuffers:
    | { islands: StorageBuffer; pieces: StorageBuffer }
    | undefined;
  let colorBuffer: StorageBuffer | undefined;
  let moduleBuffer: StorageBuffer | undefined;
  let world: PackedZoning | null = null;
  let worldBuffers:
    | {
        points: StorageBuffer;
        polygons: StorageBuffer;
        segments: StorageBuffer;
      }
    | undefined;
  let worldDirty = false;
  let bankBuffers: BankBuffers | undefined;
  const spares = new Map<MapName, Texture>();
  const retired = new Set<Texture>();
  const linear = sampler(gpu, { magFilter: "linear", minFilter: "linear" });

  const fit = (current: StorageBuffer | undefined, bytes: number) => {
    if (current && current.size >= bytes) {
      return current;
    }
    return storage(
      gpu,
      Math.max(256, Math.ceil((bytes * 1.5) / 4) * 4),
      "read"
    );
  };

  const upload = (
    current: StorageBuffer | undefined,
    data: ArrayBuffer | Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>
  ) => {
    const buffer = fit(current, data.byteLength);
    buffer.write(data);
    return buffer;
  };

  const uploadCoasts = (chart: Chart) => {
    if (coastBuffers?.chart === chart) {
      return coastBuffers;
    }
    const packed = packCoasts(chart);
    coastBuffers = {
      chart,
      coasts: upload(coastBuffers?.coasts, packed.coasts),
      segments: upload(coastBuffers?.segments, packed.segments),
    };
    return coastBuffers;
  };

  const createPasses = (layout: BakeLayout): Passes => {
    const levels = mipLevelCount(layout.frame.resolution) - 1;
    const downsample = (label: string) =>
      Array.from({ length: levels }, (_, i) =>
        effect(gpu, shaders.downsample, { label: `${label}-${i + 1}` })
      );
    return {
      coasts: effect(gpu, shaders.coasts, { label: "islands-coasts" }),
      coverage: effect(gpu, shaders.coverage, { label: "islands-coverage" }),
      distance: effect(gpu, shaders.distance, { label: "islands-distance" }),
      downsample: {
        distance: downsample("islands-distance-mip"),
        height: downsample("islands-height-mip"),
      },
      files: draw(gpu, {
        blend: "premultiplied",
        label: "islands-files",
        shader: shaders.files,
        vertices: 6,
      }),
      flow: compute(gpu, shaders.flow, {
        label: "islands-flow",
        set: { linear },
      }),
      height: draw(gpu, {
        constants: {
          SCALABLE_HEIGHT: layout.scalable,
          WRITE_FOOTPRINTS: layout.footprints,
        },
        label: "islands-height",
        set: { linear },
        shader: shaders.height,
      }),
      key: passesKey(layout),
      light: compute(gpu, shaders.light, {
        label: "islands-light",
        set: { linear },
      }),
      paint: compute(gpu, shaders.paint, { label: "islands-paint" }),
      seabed: effect(gpu, shaders.seabed, {
        label: "islands-seabed",
        set: { linear },
      }),
      zoning: createZoningDraws(gpu, shaders.zoning),
    };
  };

  const disposePasses = (p: Passes) => {
    for (const pass of [
      p.distance,
      p.coasts,
      p.coverage,
      p.height,
      p.seabed,
      ...p.downsample.distance,
      ...p.downsample.height,
    ]) {
      pass.dispose();
    }
    p.files.dispose();
    for (const d of [
      ...Object.values(p.zoning.zones),
      p.zoning.rings,
      p.zoning.reserves,
      p.zoning.roads,
    ]) {
      d.dispose();
    }
    p.flow.dispose();
    p.light.dispose();
    p.paint.dispose();
  };

  const encodeMips = (f: Frame, dest: Texture, chain: readonly Effect[]) => {
    for (const [i, pass] of chain.entries()) {
      pass.set({
        source: dest.createView({ baseMipLevel: i, mipLevelCount: 1 }),
      });
      f.pass(levelTarget([dest], i + 1), pass);
    }
  };

  interface Build {
    readonly chart: Chart;
    readonly f: Frame;
    readonly layout: BakeLayout;
    readonly maps: Record<MapName, Texture>;
    readonly p: Passes;
    readonly params: MapParams;
  }

  const groupsOf = (mf: MapFrame) => Math.ceil(mf.resolution / WORKGROUP);

  const encodeZoning = ({ f, layout, maps, p }: Build) => {
    worldDirty = false;
    const packed = world;
    if (!packed) {
      f.pass(levelTarget([maps.zoning], 0), () => undefined);
      return;
    }
    const buffers = {
      points: upload(worldBuffers?.points, packed.points),
      polygons: upload(worldBuffers?.polygons, packed.polygons),
      segments: upload(worldBuffers?.segments, packed.segments),
    };
    worldBuffers = buffers;
    const set = { params: zoningUniforms(layout.frame), ...buffers };
    f.pass(levelTarget([maps.zoning], 0), (pass) => {
      const polygons = (d: Draw, run: { count: number; first: number }) => {
        if (run.count > 0) {
          d.set(set);
          pass.draw(d, { firstInstance: run.first, instances: run.count });
        }
      };
      for (const kind of ZONE_ORDER) {
        polygons(p.zoning.zones[kind], packed.zones[kind]);
      }
      polygons(p.zoning.rings, packed.rings);
      polygons(p.zoning.reserves, packed.reserves);
      if (packed.segmentCount > 0) {
        p.zoning.roads.set(set);
        pass.draw(p.zoning.roads, { instances: packed.segmentCount });
      }
    });
  };

  const encoders: Record<MapPassName, (build: Build) => void> = {
    coasts: ({ chart, f, layout, maps, p }) => {
      const { segments } = uploadCoasts(chart);
      const packed = packPieces(chart);
      const buffers = {
        islands: upload(pieceBuffers?.islands, packed.islands),
        pieces: upload(pieceBuffers?.pieces, packed.pieces),
      };
      pieceBuffers = buffers;
      const { coastColumns: columns, coastResolution: cellSide } = layout;
      const mf = layout.frame;
      const coastsFrame = frameUniform({
        ...mf,
        resolution: cellSide,
        texel: (mf.texel * mf.resolution) / cellSide,
      });
      const cellsPerLayer = columns * columns;
      for (let island = 0; island < chart.islands.length; island += 1) {
        const cell = island % cellsPerLayer;
        const offset = [
          (cell % columns) * cellSide,
          Math.floor(cell / columns) * cellSide,
        ] as const;
        p.coasts.set({
          islands: buffers.islands,
          params: { frame: coastsFrame, island, offset },
          pieces: buffers.pieces,
          segments,
        });
        f.pass(
          {
            clear: false,
            target: levelTarget(
              [maps.coasts],
              0,
              Math.floor(island / cellsPerLayer)
            ),
            viewport: {
              height: cellSide,
              width: cellSide,
              x: offset[0],
              y: offset[1],
            },
          },
          p.coasts
        );
      }
    },
    coverage: ({ f, layout, maps, p, params }) => {
      p.coverage.set({
        distance: maps.distance,
        params: { feather: params.feather, frame: frameUniform(layout.frame) },
      });
      f.pass(levelTarget([maps.coverage], 0), p.coverage);
    },
    distance: ({ chart, f, layout, maps, p }) => {
      const { coasts, segments } = uploadCoasts(chart);
      p.distance.set({
        coasts,
        params: {
          frame: frameUniform(layout.frame),
          islandCount: chart.islands.length,
        },
        segments,
      });
      f.pass(levelTarget([maps.distance, maps.islands], 0), p.distance);
      encodeMips(f, maps.distance, p.downsample.distance);
    },
    files: ({ chart, f, layout, maps, p, params }) => {
      moduleBuffer = upload(moduleBuffer, packModules(chart));
      p.files.set({
        files: moduleBuffer,
        params: filesUniforms(params, layout.frame),
      });
      f.pass(levelTarget([maps.files], 0), (pass) => {
        if (chart.modules.length > 0) {
          pass.draw(p.files, { instances: chart.modules.length });
        }
      });
    },
    flow: ({ f, layout, maps, p, params }) => {
      p.flow.set({
        distance: maps.distance,
        flow: maps.flow,
        height: maps.height,
        params: flowUniforms(params, layout.frame),
      });
      const groups = groupsOf(layout.frame);
      f.computePass((c) => c.dispatch(p.flow, groups, groups));
    },
    height: ({ chart, f, layout, maps, p, params }) => {
      const mf = layout.frame;
      const packed = packBanks(chart);
      bankBuffers = {
        banks: upload(bankBuffers?.banks, packed.banks),
        islands: upload(bankBuffers?.islands, packed.islands),
        members: upload(bankBuffers?.members, packed.members),
      };
      const workspace = heightWorkspace(gpu, chart, mf.resolution);
      releaseWorkspace(f, workspace);
      const bindings = heightBindings(params, mf, packed, bankBuffers, maps);
      for (
        let rowStart = 0;
        rowStart < mf.resolution;
        rowStart += workspace.rows
      ) {
        p.height.set({
          ...bindings,
          footprint: maps.footprints,
          masks: workspace.masks,
          params: {
            ...bindings.params,
            coastColumns: layout.coastColumns,
            rowStart,
          },
          states: workspace.states,
        });
        f.pass(
          {
            clear: false,
            target: levelTarget([maps.height, maps.rings], 0),
            viewport: {
              height: Math.min(workspace.rows, mf.resolution - rowStart),
              width: mf.resolution,
              x: 0,
              y: rowStart,
            },
          },
          p.height
        );
      }
      encodeMips(f, maps.height, p.downsample.height);
    },
    light: ({ f, layout, maps, p, params }) => {
      p.light.set({
        height: maps.height,
        light: maps.light,
        params: lightUniforms(params, layout.frame),
        shade: maps.shade,
      });
      const groups = groupsOf(layout.frame);
      f.computePass((c) => c.dispatch(p.light, groups, groups));
    },
    paint: ({ chart, f, layout, maps, p, params }) => {
      const colors = placeholderColors(chart, params.palette);
      colorBuffer = fit(colorBuffer, colors.byteLength);
      colorBuffer.write(colors);
      p.paint.set({
        colors: colorBuffer,
        coverage: maps.coverage,
        distance: maps.distance,
        height: maps.height,
        islands: maps.islands,
        paint: maps.paint,
        params: paintUniforms(params, layout.frame, chart),
      });
      const groups = groupsOf(layout.frame);
      f.computePass((c) => c.dispatch(p.paint, groups, groups));
    },
    seabed: ({ chart, f, layout, maps, p, params }) => {
      p.seabed.set({
        distance: maps.distance,
        height: maps.height,
        params: seabedUniforms(params, layout.frame, banksOf(chart).levels),
      });
      f.pass(levelTarget([maps.seabed], 0), p.seabed);
    },
    zoning: encodeZoning,
  };

  const dirtyPasses = (chart: Chart, params: MapParams): readonly MapPass[] => {
    if (!(last && published) || chart !== last.chart) {
      return MAP_PASSES;
    }
    const changed = changedParams(last.params, params).flatMap(
      (key) => MAP_OF_PARAM[key]
    );
    return passesWithDependants(worldDirty ? [...changed, "zoning"] : changed);
  };

  const freeRetired = () => {
    for (const old of retired) {
      old.destroy();
    }
    retired.clear();
  };

  const passesFor = (layout: BakeLayout): Passes => {
    if (passes?.key !== passesKey(layout)) {
      if (passes) {
        disposePasses(passes);
      }
      passes = createPasses(layout);
    }
    return passes;
  };

  const take = (rebuilt: readonly MapName[], layout: BakeLayout) => {
    const next: Partial<Record<MapName, Texture>> = {};
    for (const name of rebuilt) {
      const wanted = mapTextureDescriptor(name, layout);
      let spare = spares.get(name);
      spares.delete(name);
      if (
        spare &&
        (spare.size[0] !== wanted.size[0] ||
          spare.layers !== (wanted.kind === "2d-array" ? wanted.layers : 1))
      ) {
        spare.destroy();
        spare = undefined;
      }
      next[name] =
        spare ?? texture(gpu, { ...wanted, label: `islands-${name}` });
    }
    return next;
  };

  const release = (
    rebuilt: readonly MapName[],
    resized: boolean,
    into: Frame | undefined,
    begun: number
  ): Promise<number> => {
    const replaced: Texture[] = [];
    for (const name of rebuilt) {
      const old = published?.[name];
      if (old && resized) {
        replaced.push(old);
      } else if (old) {
        spares.set(name, old);
      }
    }
    if (!into) {
      for (const old of replaced) {
        old.destroy();
      }
      return gpu.gpu.queue
        .onSubmittedWorkDone()
        .then(() => performance.now() - begun);
    }
    for (const old of replaced) {
      retired.add(old);
    }
    return Promise.resolve()
      .then(() => into.done)
      .then(() => {
        for (const old of replaced) {
          if (retired.delete(old)) {
            old.destroy();
          }
        }
        return performance.now() - begun;
      });
  };

  return {
    build(chart, params, into) {
      const rebuilding = dirtyPasses(chart, params);
      const rebuilt = rebuilding.flatMap((pass) => [...pass.outputs]);
      if (rebuilt.length === 0) {
        return { ms: {}, rebuilt, settled: Promise.resolve(0) };
      }
      const layout = bakeLayout(
        chart,
        params,
        gpu.gpu.limits.maxTextureDimension2D,
        gpu.gpu.limits.maxTextureArrayLayers
      );
      const p = passesFor(layout);
      const resized = last?.layout.frame.resolution !== layout.frame.resolution;
      const begun = performance.now();
      const next = take(rebuilt, layout);
      const maps = mergeTextures(published, next);
      const ms: Partial<Record<MapName, number>> = {};
      const encode = (f: Frame) => {
        const build: Build = { chart, f, layout, maps, p, params };
        for (const pass of rebuilding) {
          const start = performance.now();
          encoders[pass.name](build);
          ms[pass.name] = performance.now() - start;
          for (const output of pass.outputs) {
            ms[output] ??= 0;
          }
        }
      };
      try {
        if (into) {
          encode(into);
        } else {
          frame(gpu, encode);
        }
      } catch (error) {
        for (const name of rebuilt) {
          const taken = next[name];
          if (taken) {
            spares.set(name, taken);
          }
        }
        throw error;
      }
      const settled = release(rebuilt, resized, into, begun);
      published = maps;
      last = { chart, layout, params: { ...params } };
      return { ms, rebuilt, settled };
    },
    dispose() {
      if (passes) {
        disposePasses(passes);
        passes = undefined;
      }
      for (const name of MAP_NAMES) {
        published?.[name].destroy();
      }
      for (const spare of spares.values()) {
        spare.destroy();
      }
      spares.clear();
      freeRetired();
      coastBuffers = undefined;
      pieceBuffers = undefined;
      colorBuffer = undefined;
      moduleBuffer = undefined;
      worldBuffers = undefined;
      bankBuffers = undefined;
      published = undefined;
      last = undefined;
    },
    get frame() {
      if (!last) {
        throw new Error("Maps.frame is read before the first build()");
      }
      return last.layout.frame;
    },
    get seabed() {
      if (!last) {
        throw new Error("Maps.seabed is read before the first build()");
      }
      return seabedFrame(last.layout.frame, last.params);
    },
    get selection() {
      return last && published && last.layout.footprints
        ? {
            footprints: published.footprints,
            wordsPerBank: wordsPerBank(last.chart.islands.length),
          }
        : null;
    },
    setWorld(plan) {
      world = plan ? packZoning(plan) : null;
      worldDirty = true;
    },
    get textures() {
      if (!published) {
        throw new Error("Maps.textures is read before the first build()");
      }
      return published;
    },
  };
}
