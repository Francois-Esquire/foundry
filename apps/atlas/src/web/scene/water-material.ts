import {
  Color,
  DataTexture,
  LinearFilter,
  MathUtils,
  type Texture,
  Vector2,
} from "three";
import {
  abs,
  cos,
  dot,
  Fn,
  float,
  floor,
  fract,
  Loop,
  max,
  mix,
  pow,
  texture as sampleTexture,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import {
  MeshStandardNodeMaterial,
  type Node,
  type UniformNode,
} from "three/webgpu";

import type { ChartSettings } from "../chart-settings";
import { defaultChartSettings } from "../chart-settings";
import type { AtlasData, Polygon } from "../types";
import { coastalCurrent } from "./coastal-current";
import { dependencyCurrent } from "./current-field";
import { oceanField } from "./ocean";
import type { PlaybackSnapshot } from "./playback";
import { waveArrivalField } from "./wave-field";

export function createWaterMaterial(
  map: Texture,
  data: AtlasData,
  coasts?: Polygon[]
) {
  const field = dependencyCurrent(data);
  const { canvas, distances, scale } = oceanField(data, 256, coasts);
  const { width, height } = canvas;
  const vx = new Float32Array(width * height);
  const vy = new Float32Array(width * height);
  const strength = new Float32Array(width * height);
  const land = Uint8Array.from(distances, (distance) =>
    distance === 0 ? 1 : 0
  );
  createWaterMaterialY(height, width, field, data, vx, vy, strength);
  const current = coastalCurrent(vx, vy, land, width, height);
  const zeros = new Float32Array(vx.length);
  const east = coastalCurrent(
    new Float32Array(vx.length).fill(1),
    zeros,
    land,
    width,
    height
  );
  const north = coastalCurrent(
    zeros,
    new Float32Array(vx.length).fill(-1),
    land,
    width,
    height
  );
  let velocityScale = 1;
  for (let i = 0; i < vx.length; i += 1) {
    velocityScale = Math.max(
      velocityScale,
      Math.abs(current.x[i] ?? 0),
      Math.abs(current.y[i] ?? 0),
      Math.abs(east.x[i] ?? 0),
      Math.abs(east.y[i] ?? 0),
      Math.abs(north.x[i] ?? 0),
      Math.abs(north.y[i] ?? 0)
    );
  }
  const pixels = new Uint8Array(width * height * 4);
  createWaterMaterialY2(
    height,
    width,
    distances,
    scale,
    pixels,
    current,
    velocityScale,
    strength
  );
  const texture = new DataTexture(pixels, width, height);
  texture.magFilter = LinearFilter;
  texture.minFilter = texture.magFilter;
  texture.needsUpdate = true;
  const wreckPixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mapX = ((x + 0.5) / width - 0.5) * data.width;
      const mapY = ((y + 0.5) / height - 0.5) * data.height;
      const depth = Math.max(
        0,
        ...(data.formerPackages ?? []).map((wreck) =>
          Math.max(
            0,
            Math.min(1, (40 - Math.hypot(mapX - wreck.x, mapY - wreck.y)) / 22)
          )
        )
      );
      wreckPixels[((height - 1 - y) * width + x) * 4] = Math.round(depth * 255);
    }
  }
  const wreckMask = new DataTexture(wreckPixels, width, height);
  wreckMask.magFilter = LinearFilter;
  wreckMask.minFilter = wreckMask.magFilter;
  wreckMask.needsUpdate = true;
  const windPixels = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      windPixels.set(
        [
          east.x[i] ?? 0,
          -(east.y[i] ?? 0),
          north.x[i] ?? 0,
          -(north.y[i] ?? 0),
        ].map((value) =>
          Math.round(((value / velocityScale) * 0.5 + 0.5) * 255)
        ),
        ((height - 1 - y) * width + x) * 4
      );
    }
  }
  const windTexture = new DataTexture(windPixels, width, height);
  windTexture.magFilter = LinearFilter;
  windTexture.minFilter = windTexture.magFilter;
  windTexture.needsUpdate = true;
  const wavePixels = new Uint8Array(pixels.length);
  const waveTexture = new DataTexture(wavePixels, width, height);
  waveTexture.magFilter = LinearFilter;
  waveTexture.minFilter = waveTexture.magFilter;
  const waveRange = uniform(1);
  const rebuildWaves = (direction: number) => {
    const { arrival, exposure } = waveArrivalField(
      distances,
      width,
      height,
      scale,
      direction
    );
    waveRange.value = arrival.reduce(
      (top, value) => (Number.isFinite(value) ? Math.max(top, value) : top),
      1
    );
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const value = arrival[i] ?? Number.POSITIVE_INFINITY;
        const encoded = Number.isFinite(value)
          ? Math.round((value / waveRange.value) * 65_535)
          : 0;
        wavePixels.set(
          [
            Math.floor(encoded / 256),
            encoded % 256,
            Number.isFinite(value) ? Math.round((exposure[i] ?? 0) * 255) : 0,
            Math.round(Math.min(1, (distances[i] ?? 0) / scale / 100) * 255),
          ],
          ((height - 1 - y) * width + x) * 4
        );
      }
    }
    waveTexture.needsUpdate = true;
  };
  rebuildWaves(defaultChartSettings.windDirection);
  const controls = {
    currentSpeed: uniform(1),
    dependencyPower: uniform(1),
    waterContrast: uniform(1),
    waterPigment: uniform(new Color()),
    waveAmount: uniform(0),
    wavelength: uniform(36),
    wavePower: uniform(0),
    windBearing: uniform(new Vector2()),
    windCoupling: uniform(0),
    windPower: uniform(0),
  };
  const originalWater = new Color("#d5dbca");
  const configure = (settings: ChartSettings) => {
    const angle = (settings.windDirection * Math.PI) / 180;
    controls.windBearing.value.set(Math.sin(angle), Math.cos(angle));
    controls.windPower.value = settings.windStrength;
    controls.windCoupling.value = settings.windInfluence;
    controls.dependencyPower.value = settings.dependencyInfluence;
    controls.currentSpeed.value = settings.currentSpeed;
    controls.waveAmount.value = settings.waveAmount;
    controls.wavelength.value = settings.wavelength;
    controls.wavePower.value = settings.waveStrength;
    controls.waterContrast.value = settings.waterContrast;
    const pigment = controls.waterPigment.value.set(settings.waterColor);
    pigment.setRGB(
      pigment.r / originalWater.r,
      pigment.g / originalWater.g,
      pigment.b / originalWater.b
    );
  };
  configure(defaultChartSettings);
  const time = uniform(0);
  const windTime = uniform(0),
    waveTime = uniform(0);
  const amount = uniform(1);
  const wreckReveal = uniform(0.2);
  const material = new MeshStandardNodeMaterial({
    depthWrite: !data.formerPackages?.length,
    map,
    metalness: 0,
    roughness: 0.96,
    transparent: !!data.formerPackages?.length,
  });
  const shading = createWaterShading({
    amount,
    controls,
    currentField: texture,
    map,
    size: new Vector2(data.width, data.height),
    time,
    velocityScale,
    waveField: waveTexture,
    waveRange,
    waveTime,
    windField: windTexture,
    windTime,
    wreckMask,
    wreckReveal,
  });
  material.colorNode = shading.color;
  material.opacityNode = shading.opacity;
  return {
    configure,
    dispose() {
      material.dispose();
      texture.dispose();
      wreckMask.dispose();
      windTexture.dispose();
      waveTexture.dispose();
    },
    material,
    rebuildWaves,
    setWreckReveal(pixelsPerUnit: number) {
      wreckReveal.value = MathUtils.clamp((pixelsPerUnit - 0.5) / 2, 0.12, 1);
    },
    update(playback: PlaybackSnapshot, currentStrength: number) {
      time.value = playback.tracks.current.time;
      windTime.value = playback.tracks.wind.time;
      waveTime.value = playback.tracks.waves.time;
      amount.value = currentStrength;
    },
  };
}

function createWaterMaterialY2(
  height: number,
  width: number,
  distances: Float32Array<ArrayBufferLike>,
  scale: number,
  pixels: Uint8Array<ArrayBuffer>,
  current: { x: Float32Array<ArrayBuffer>; y: Float32Array<ArrayBuffer> },
  velocityScale: number,
  strength: Float32Array<ArrayBuffer>
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const distance = (distances[i] ?? 0) / scale;
      pixels.set(
        [
          Math.round((((current.x[i] ?? 0) / velocityScale) * 0.5 + 0.5) * 255),
          Math.round(
            ((-(current.y[i] ?? 0) / velocityScale) * 0.5 + 0.5) * 255
          ),
          Math.round((strength[i] ?? 0) * 255),
          Math.round(Math.min(1, distance / 6) * 255),
        ],
        ((height - 1 - y) * width + x) * 4
      );
    }
  }
}

function createWaterMaterialY(
  height: number,
  width: number,
  field: {
    prevailing: { x: number; y: number };
    sample(x: number, y: number): { strength: number; x: number; y: number };
  },
  data: AtlasData,
  vx: Float32Array<ArrayBuffer>,
  vy: Float32Array<ArrayBuffer>,
  strength: Float32Array<ArrayBuffer>
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const flow = field.sample(
        ((x + 0.5) / width) * data.width - data.width / 2,
        ((y + 0.5) / height) * data.height - data.height / 2
      );
      vx[i] = flow.x;
      vy[i] = flow.y;
      strength[i] = flow.strength;
    }
  }
}

type FloatUniform = UniformNode<"float", number>;
type Vec2Node = Node<"vec2">;
type FloatNode = Node<"float">;

interface WaterShadingInputs {
  amount: FloatUniform;
  controls: {
    currentSpeed: FloatUniform;
    dependencyPower: FloatUniform;
    waterContrast: FloatUniform;
    waterPigment: UniformNode<"color", Color>;
    waveAmount: FloatUniform;
    wavelength: FloatUniform;
    wavePower: FloatUniform;
    windBearing: UniformNode<"vec2", Vector2>;
    windCoupling: FloatUniform;
    windPower: FloatUniform;
  };
  currentField: Texture;
  map: Texture;
  size: Vector2;
  time: FloatUniform;
  velocityScale: number;
  waveField: Texture;
  waveRange: FloatUniform;
  waveTime: FloatUniform;
  windField: Texture;
  windTime: FloatUniform;
  wreckMask: Texture;
  wreckReveal: FloatUniform;
}

/**
 * The chart water in TSL: pigment washes advected along dependency currents,
 * wind breeze, depth-aware wave crests and the wreck reveal. Node materials
 * compile this for WebGPU and the WebGL 2 fallback alike, so the pipeline can
 * read the water's depth and normals like any other surface.
 */
function createWaterShading(inputs: WaterShadingInputs) {
  const { controls, size } = inputs;
  const currentSize = vec2(size.x, size.y);
  const velocityScale = float(inputs.velocityScale);
  const hash = Fn(([p]: [Vec2Node]) =>
    fract(sin(dot(p, vec2(127.1, 311.7))).mul(43_758.5453))
  );
  const noise = Fn(([p]: [Vec2Node]) => {
    const i = floor(p);
    const f = fract(p).toVar();
    f.assign(f.mul(f).mul(float(3).sub(f.mul(2))));
    return mix(
      mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
      mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x),
      f.y
    );
  });
  const velocity = Fn(([p]: [Vec2Node]) => {
    const flow = sampleTexture(inputs.currentField, p);
    const wind = sampleTexture(inputs.windField, p).mul(2).sub(1);
    const drift = flow.rg.mul(2).sub(1).mul(controls.dependencyPower);
    const gust = wind.rg
      .mul(controls.windBearing.x)
      .add(wind.ba.mul(controls.windBearing.y))
      .mul(controls.windPower)
      .mul(controls.windCoupling);
    return drift
      .add(gust)
      .mul(36)
      .mul(velocityScale)
      .mul(flow.a)
      .div(currentSize);
  });
  const step = Fn(([p, dt]: [Vec2Node, FloatNode]) => {
    const mid = p.add(velocity(p).mul(dt).mul(0.5));
    const next = p.add(velocity(mid).mul(dt));
    const blocked = sampleTexture(inputs.currentField, mid)
      .a.lessThan(0.05)
      .or(sampleTexture(inputs.currentField, next).a.lessThan(0.05));
    return select(blocked, p, next);
  });
  const wash = Fn(([start, phase]: [Vec2Node, FloatNode]) => {
    const p = vec2(start).toVar();
    const upstream = phase.negate().mul(0.75);
    Loop(8, () => {
      p.assign(step(p, upstream));
    });
    const pigment = float(0).toVar();
    Loop(5, () => {
      pigment.addAssign(
        noise(p.mul(currentSize).div(24))
          .mul(0.8)
          .add(noise(p.mul(currentSize).div(72)).mul(0.2))
      );
      p.assign(step(p, float(0.7)));
    });
    return pigment.div(5);
  });
  const color = Fn(() => {
    const mapUv = uv();
    const base = sampleTexture(inputs.map, mapUv);
    const flow = sampleTexture(inputs.currentField, mapUv);
    const phase = fract(inputs.time.mul(controls.currentSpeed).div(6));
    const nextPhase = fract(phase.add(0.5));
    const blend = abs(phase.mul(2).sub(1));
    const washed = mix(wash(mapUv, phase), wash(mapUv, nextPhase), blend);
    const currentPigment = washed
      .sub(0.5)
      .mul(0.7)
      .mul(
        max(
          flow.b.mul(controls.dependencyPower),
          controls.windPower.mul(controls.windCoupling)
        )
      )
      .mul(flow.a);
    const wave = sampleTexture(inputs.waveField, mapUv);
    const arrival = wave.r
      .mul(65_280)
      .add(wave.g.mul(255))
      .div(65_535)
      .mul(inputs.waveRange);
    const wavePhase = arrival
      .sub(inputs.waveTime)
      .mul(18)
      .div(controls.wavelength)
      .mul(6.283_185);
    const envelope = select(
      controls.waveAmount.greaterThan(0),
      smoothstep(
        float(1).sub(controls.waveAmount),
        float(1),
        noise(mapUv.mul(currentSize).div(130))
      ),
      float(0)
    );
    const crest = pow(max(float(0), cos(wavePhase)), 10);
    const swell = crest
      .sub(0.12)
      .mul(envelope)
      .mul(wave.b)
      .mul(float(1).sub(wave.a.mul(0.65)))
      .mul(controls.wavePower)
      .mul(controls.windPower)
      .mul(flow.a);
    const windUv = mapUv
      .mul(currentSize)
      .div(18)
      .sub(controls.windBearing.mul(inputs.windTime).mul(0.9));
    const breeze = noise(windUv)
      .sub(0.5)
      .mul(0.055)
      .mul(controls.windPower)
      .mul(flow.a);
    const lift = float(1).add(
      currentPigment
        .add(swell.mul(0.5))
        .add(breeze)
        .mul(controls.waterContrast)
        .mul(inputs.amount)
    );
    return vec3(base.rgb.mul(controls.waterPigment).mul(lift));
  })();
  const opacity = float(1).sub(
    sampleTexture(inputs.wreckMask, uv()).r.mul(0.75).mul(inputs.wreckReveal)
  );
  return { color, opacity };
}
