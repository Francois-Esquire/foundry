import { planarNoise } from "../../../../shaders/noise/planar.wgsl";

export const FOAM = vec3f(0.97, 0.98, 0.96);

const SWASH_CELLS = 2.5;
const PATCH_CELLS = 3.0;
const FROTH_CELLS = 0.35;
const CREST_FRONT = 0.08;
const CREST_TAIL = 0.45;
const CREST_MEAN = 0.12;
const CREST_REACH = 4.0;
const EDGE_SHARE = 0.4;

export fn surf(p: vec2f, coast: f32, edge: f32, breaking: f32, spacing: f32, speed: f32, time: f32, footprint: f32) -> f32 {
  if (breaking <= 0.0 || spacing <= 0.0) {
    return 0.0;
  }
  let swash = planarNoise(p / (spacing * SWASH_CELLS), 7u, 770u);
  let phase = fract((coast + speed * time) / spacing + 0.4 * swash);
  let crest = smoothstep(0.0, CREST_FRONT, phase) * (1.0 - smoothstep(CREST_FRONT, CREST_TAIL, phase));
  let patches = smoothstep(-0.2, 0.3, planarNoise(p / (spacing * PATCH_CELLS), 7u, 771u));
  let froth = smoothstep(-0.35, 0.45, planarNoise(p / (spacing * FROTH_CELLS), 7u, 772u));
  let resolved = 1.0 - smoothstep(0.15, 0.4, footprint / spacing);
  let reach = 1.0 - smoothstep(0.0, CREST_REACH * spacing, edge);
  let crests = mix(CREST_MEAN, crest * patches * froth, resolved) * reach;
  let line = (1.0 - smoothstep(0.0, EDGE_SHARE * spacing, edge + 0.15 * spacing * swash)) * mix(1.0, 0.6 + 0.4 * froth, resolved);
  return saturate(max(0.75 * crests, line) * breaking);
}

const WASH_COLLAR = 0.18;
const WASH_RING = 0.07;
const WASH_RINGS = 2u;
const WASH_CELLS = 5.0;
const WASH_WANDER = 0.6;
const WASH_WAVER = 0.12;
const WAVER_CELLS = 1.5;
const WASH_MEAN = 0.15;

export fn cliffWash(p: vec2f, coast: f32, wall: f32, width: f32, period: f32, time: f32, footprint: f32) -> f32 {
  if (wall <= 0.0 || width <= 0.0 || coast > 1.2 * width || coast < -0.5) {
    return 0.0;
  }
  let off = coast + WASH_WAVER * width * planarNoise(p / (width * WAVER_CELLS), 7u, 774u);
  let arrival = WASH_WANDER * planarNoise(p / (width * WASH_CELLS), 7u, 773u);
  let collar = 1.0 - smoothstep(0.6, 1.0, off / (WASH_COLLAR * width));
  var spread = 0.0;
  for (var k = 0u; k < WASH_RINGS; k++) {
    let t = fract(time / max(period * f32(WASH_RINGS), 1e-3) + arrival + f32(k) / f32(WASH_RINGS));
    let at = mix(WASH_COLLAR, 1.0, t) * width;
    let ring = WASH_RING * width * (1.0 + t);
    spread = max(spread, (1.0 - smoothstep(0.5 * ring, ring, abs(off - at))) * (1.0 - t));
  }
  let soft = 0.5 * footprint / max(WASH_RING * width, 1e-3);
  let crisp = smoothstep(0.5 - soft - 0.05, 0.5 + soft + 0.05, max(collar, spread));
  let rings = mix(crisp, max(collar, WASH_MEAN * (1.0 - off / width)), saturate(soft - 0.5));
  return saturate(rings * wall);
}

const SHOAL_SAND = vec3f(0.95, 0.94, 0.82);
const SHOAL_AQUA = vec3f(0.7, 0.95, 0.9);

export struct Shoal {
  color: vec3f,
  glow: vec3f,
}

export fn shoal(color: vec3f, depth: f32, coast: f32, reach: f32, top: f32, steep: f32, sunlit: f32, strength: f32) -> Shoal {
  let beach = step(-0.5, coast) * (1.0 - smoothstep(0.25 * reach, reach, coast)) * (1.0 - steep);
  let halo = beach * (1.0 - smoothstep(0.4 * top, 2.75 * top, depth)) * strength;
  let tint = mix(SHOAL_AQUA, SHOAL_SAND, 1.0 - smoothstep(0.15 * top, 1.3 * top, depth));
  return Shoal(mix(color, tint, saturate(halo * 0.55)), tint * halo * (0.03 + 0.1 * sunlit));
}

const UPRUSH = 0.3;
const SHEET_EDGE = 0.015;
const LACE = 0.05;
const LACE_CELL = 1.2;
const SWASH_CELL = 9.0;
const SWASH_WANDER = 0.7;
const SWASH_VARY = 0.35;
const DRYING = 0.7;

export struct Swash {
  sheet: f32,
  lace: f32,
  wet: f32,
}

export fn swash(p: vec2f, height: f32, reach: f32, period: f32, time: f32, footprint: f32) -> Swash {
  if (reach <= 0.0 || height > reach * (1.0 + SWASH_VARY) || height < -SHEET_EDGE) {
    return Swash(0.0, 0.0, 0.0);
  }
  let arrival = SWASH_WANDER * planarNoise(p / SWASH_CELL, 7u, 776u);
  let peak = reach * (1.0 + SWASH_VARY * planarNoise(p / SWASH_CELL, 7u, 777u));
  let phase = fract(time / max(period, 1e-3) + arrival);
  let rising = phase < UPRUSH;
  let up = phase / UPRUSH;
  let down = (phase - UPRUSH) / (1.0 - UPRUSH);
  let level = peak * select(1.0 - smoothstep(0.0, 1.0, down), 1.0 - (1.0 - up) * (1.0 - up), rising);
  let sheet = 1.0 - smoothstep(level - SHEET_EDGE, level + SHEET_EDGE, height);
  let froth = smoothstep(-0.3, 0.5, planarNoise(p / LACE_CELL, 7u, 778u));
  let resolved = 1.0 - smoothstep(0.3, 1.0, footprint);
  let leading = select(0.5 * (1.0 - down), 1.0, rising);
  let lace = sheet * (1.0 - smoothstep(0.0, LACE, level - height)) * froth * leading * resolved;
  let dried = select(DRYING, DRYING * down, !rising);
  let wet = 1.0 - smoothstep(level, peak, height) * dried;
  return Swash(sheet, lace, wet * step(height, peak));
}
