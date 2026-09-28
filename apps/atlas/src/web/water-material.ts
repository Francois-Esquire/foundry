import {
  Color,
  DataTexture,
  LinearFilter,
  MathUtils,
  MeshStandardMaterial,
  type Texture,
  Vector2,
} from "three";

import type { ChartSettings } from "./chart-settings";
import { defaultChartSettings } from "./chart-settings";
import { coastalCurrent } from "./coastal-current";
import { dependencyCurrent } from "./current-field";
import { oceanField } from "./ocean";
import type { PlaybackSnapshot } from "./playback";
import type { AtlasData, Polygon } from "./types";
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
  const waveRange = { value: 1 };
  const rebuildWaves = (direction: number) => {
    const { arrival, exposure } = waveArrivalField(
      distances,
      width,
      height,
      scale,
      direction
    );
    waveRange.value = arrival.reduce(
      (max, value) => (Number.isFinite(value) ? Math.max(max, value) : max),
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
    currentSpeed: { value: 1 },
    dependencyPower: { value: 1 },
    waterContrast: { value: 1 },
    waterPigment: { value: new Color() },
    waveAmount: { value: 0 },
    wavelength: { value: 36 },
    wavePower: { value: 0 },
    windBearing: { value: new Vector2() },
    windCoupling: { value: 0 },
    windPower: { value: 0 },
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
  const time = { value: 0 };
  const windTime = { value: 0 },
    waveTime = { value: 0 };
  const amount = { value: 1 };
  const wreckReveal = { value: 0.2 };
  const material = new MeshStandardMaterial({
    depthWrite: !data.formerPackages?.length,
    map,
    metalness: 0,
    roughness: 0.96,
    transparent: !!data.formerPackages?.length,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.currentField = { value: texture };
    shader.uniforms.wreckMask = { value: wreckMask };
    shader.uniforms.currentTime = time;
    Object.assign(shader.uniforms, controls, {
      waveField: { value: waveTexture },
      waveRange,
      waveTime,
      windField: { value: windTexture },
      windTime,
    });
    shader.uniforms.currentVelocityScale = { value: velocityScale };
    shader.uniforms.currentAmount = amount;
    shader.uniforms.wreckReveal = wreckReveal;
    shader.uniforms.currentSize = {
      value: new Vector2(data.width, data.height),
    };
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
uniform sampler2D currentField;
uniform sampler2D wreckMask;
uniform sampler2D windField;
uniform sampler2D waveField;
uniform float waveRange, windTime, waveTime;
uniform vec2 windBearing;
uniform float windPower, windCoupling, dependencyPower, currentSpeed;
uniform float waveAmount, wavelength, wavePower, waterContrast;
uniform vec3 waterPigment;
uniform float currentTime;
uniform float currentVelocityScale;
uniform float currentAmount;
uniform float wreckReveal;
uniform vec2 currentSize;
float currentHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float currentNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(currentHash(i), currentHash(i + vec2(1,0)), f.x), mix(currentHash(i + vec2(0,1)), currentHash(i + vec2(1,1)), f.x), f.y);
}
vec2 currentVelocity(vec2 uv) {
  vec4 flow = texture2D(currentField, uv);
  vec4 wind = texture2D(windField, uv) * 2.0 - 1.0;
  vec2 velocity = (flow.rg * 2.0 - 1.0) * dependencyPower + (wind.rg * windBearing.x + wind.ba * windBearing.y) * windPower * windCoupling;
  return velocity * 36.0 * currentVelocityScale * flow.a / currentSize;
}
vec2 currentStep(vec2 uv, float dt) {
  vec2 mid = uv + currentVelocity(uv) * dt * 0.5;
  vec2 next = uv + currentVelocity(mid) * dt;
  if (texture2D(currentField, mid).a < 0.05 || texture2D(currentField, next).a < 0.05) return uv;
  return next;
}
float currentWash(vec2 uv, float phase) {
  for (int i = 0; i < 8; i++) uv = currentStep(uv, -phase * 0.75);
  float pigment = 0.0;
  for (int i = 0; i < 5; i++) {
    pigment += currentNoise(uv * currentSize / 24.0) * 0.8 + currentNoise(uv * currentSize / 72.0) * 0.2;
    uv = currentStep(uv, 0.7);
  }
  return pigment / 5.0;
}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
vec4 flow = texture2D(currentField, vMapUv);
float phase = fract(currentTime * currentSpeed / 6.0);
float nextPhase = fract(phase + 0.5);
float blend = abs(phase * 2.0 - 1.0);
float wash = mix(currentWash(vMapUv, phase), currentWash(vMapUv, nextPhase), blend);
float currentPigment = (wash - 0.5) * 0.7 * max(flow.b * dependencyPower, windPower * windCoupling) * flow.a;
vec4 wave = texture2D(waveField, vMapUv);
float arrival = (wave.r * 65280.0 + wave.g * 255.0) / 65535.0 * waveRange;
float wavePhase = (arrival - waveTime) * 18.0 / wavelength * 6.283185;
float envelope = waveAmount > 0.0 ? smoothstep(1.0 - waveAmount, 1.0, currentNoise(vMapUv * currentSize / 130.0)) : 0.0;
float crest = pow(max(0.0, cos(wavePhase)), 10.0);
float swell = (crest - 0.12) * envelope * wave.b * (1.0 - wave.a * 0.65) * wavePower * windPower * flow.a;
vec2 windUv = vMapUv * currentSize / 18.0 - windBearing * windTime * 0.9;
float breeze = (currentNoise(windUv) - 0.5) * 0.055 * windPower * flow.a;
diffuseColor.rgb *= waterPigment;
diffuseColor.rgb *= 1.0 + (currentPigment + swell * 0.5 + breeze) * waterContrast * currentAmount;
diffuseColor.a *= 1.0 - texture2D(wreckMask, vMapUv).r * 0.75 * wreckReveal;
`
    );
  };
  material.customProgramCacheKey = () => "atlas-chart-tracks-v6";
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
