import { planarNoise } from "../../../../shaders/noise/planar.wgsl";

const SHADE_KEEP = vec2f(8.0, 24.0);
const GLINT_KEEP = vec2f(16.0, 48.0);
const WARP_AMPLITUDE = 7.0;
const WARP_X = mat2x2f(0.031, 0.022, -0.017, 0.035);
const WARP_Z = mat2x2f(-0.027, 0.029, 0.041, 0.012);
const WAVE_PHASE = 2.399963;
const SUN_SHININESS = 900.0;
const F0 = 0.02;

export struct Surface {
  normal: vec3f,
  glint: vec3f,
  variance: f32,
}

export fn slopeNormal(slope: vec2f) -> vec3f {
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

export fn waveSurface(xz: vec2f, footprint: f32, time: f32, strength: f32, waves: array<vec4f, 32>) -> Surface {
  let swells = sin(vec4f(xz * WARP_X, xz * WARP_Z) + vec4f(0.0, 1.7, 3.1, 4.4));
  let p = xz + vec2f(swells.x + swells.y, swells.z + swells.w) * WARP_AMPLITUDE;
  var shade = vec2f(0.0);
  var glint = vec2f(0.0);
  var variance = 0.0;
  for (var i = 0u; i < 32u; i++) {
    let wave = waves[i];
    let k = max(length(wave.xy), 1e-6);
    let wavelength = 6.2831853 / k;
    let keep = smoothstep(SHADE_KEEP.x * footprint, SHADE_KEEP.y * footprint, wavelength);
    let sharp = smoothstep(GLINT_KEEP.x * footprint, GLINT_KEEP.y * footprint, wavelength);
    let amplitude = wave.w * strength;
    let slope = amplitude * k;
    variance += 0.5 * slope * slope * (1.0 - sharp * sharp);
    let phase = dot(wave.xy, p) - wave.z * time + f32(i) * WAVE_PHASE;
    let gradient = amplitude * cos(phase) * wave.xy;
    shade += gradient * keep;
    glint += gradient * sharp;
  }
  return Surface(slopeNormal(shade), slopeNormal(glint), variance);
}

export fn sky(direction: vec3f, horizon: vec3f, zenith: vec3f) -> vec3f {
  let up = saturate(direction.y);
  return mix(horizon, zenith, sqrt(up));
}

export fn fresnel(ray: vec3f, normal: vec3f) -> f32 {
  let facing = saturate(dot(-ray, normal));
  return F0 + (1.0 - F0) * pow(1.0 - facing, 5.0);
}

export fn glint(ray: vec3f, surface: Surface, sun: vec3f) -> f32 {
  let reflected = reflect(ray, surface.glint);
  let spread = 1.0 / SUN_SHININESS + 4.0 * surface.variance;
  let shininess = 1.0 / spread;
  let lobe = pow(saturate(dot(reflected, sun)), shininess);
  return lobe * (shininess + 2.0) / (SUN_SHININESS + 2.0);
}

export fn transmittance(thickness: f32, absorption: vec3f, clarity: f32, power: f32, curve: f32) -> vec3f {
  let depth = log2(max(thickness, 1e-6) / clarity);
  let rho = exp2(power * depth);
  let grey = min(min(absorption.x, absorption.y), absorption.z);
  let tint = (absorption - grey) * exp2(power * curve * depth);
  return exp(-(grey * rho + tint));
}

export fn waterLight(visible: f32, ambient: f32) -> f32 {
  return mix(ambient, 1.0, saturate(visible));
}

const RELIEF_SHADOW = vec3f(0.56, 0.68, 0.86);
const RELIEF_SHADOW_DEEP = vec3f(0.5, 0.64, 0.92);
const RELIEF_WARM = vec3f(0.16, 0.12, 0.06);

export fn floorRelief(normal: vec3f, sun: vec3f, sunlit: f32, open: f32, deep: f32, strength: f32) -> vec3f {
  let facing = max(dot(normal, sun), 0.0) / max(sun.y, 0.1);
  let light = facing * mix(1.0, sunlit, mix(0.9, 0.25, deep));
  let shadow = mix(RELIEF_SHADOW, RELIEF_SHADOW_DEEP, deep);
  let warm = RELIEF_WARM * min(light - 1.0, 0.6) * step(1.0, light);
  let shade = (mix(shadow, vec3f(1.0), min(light, 1.0)) + warm) * (0.72 + 0.28 * open);
  return mix(vec3f(1.0), shade, strength * (1.0 - 0.7 * deep));
}

export fn riserRim(normal: vec3f, sun: vec3f, deep: f32) -> f32 {
  let riser = 1.0 - smoothstep(0.88, 0.985, normal.y);
  let toward = dot(normalize(normal.xz + vec2f(1e-5)), normalize(sun.xz + vec2f(1e-5)));
  return riser * smoothstep(0.1, 0.7, toward) * (1.0 - 0.6 * deep);
}

export fn rimmed(color: vec3f, rim: f32) -> vec3f {
  return mix(color, color * 1.2 + vec3f(0.05, 0.06, 0.05), 0.5 * saturate(rim));
}

const LIP_UP = 0.975;

export fn lipLine(up: f32, span: f32, bend: f32) -> f32 {
  let weight = smoothstep(0.04, 0.35, bend);
  let width = mix(0.6, 1.5, weight);
  let pixels = abs(up - LIP_UP) / max(span, 1e-4);
  return (1.0 - smoothstep(0.5 * width, 0.5 * width + 1.0, pixels)) * smoothstep(0.02, 0.22, bend);
}

export fn caustics(p: vec2f, size: f32, time: f32, footprint: f32) -> f32 {
  let a = 1.0 - abs(planarNoise(p / size + vec2f(0.12, 0.05) * time, 3u, 760u));
  let b = 1.0 - abs(planarNoise(p / (1.3 * size) + vec2f(-0.07, 0.1) * time, 3u, 761u));
  let resolved = 1.0 - smoothstep(0.03, 0.12, footprint / size);
  return pow(a * b, 5.0) * resolved;
}
