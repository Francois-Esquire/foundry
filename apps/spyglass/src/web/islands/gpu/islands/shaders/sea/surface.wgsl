// The sea's surface: the waves (the shared spectrum at the chart's scale,
// its domain bent by long swells), the two normals they give, the sky they
// reflect and the sun's glint on them; the water's transmittance and its
// tint by depth; the floor's relief shaded through the water's colour, the
// lit rim on each step's riser, the line at each sea step's lip and the
// caustics on the shallow floor; and the land's shadow on the water's own
// light. Pure: the
// composite (water.wgsl) owns the uniforms and passes them in.
import { planarNoise } from "../../../../shaders/noise/planar.wgsl";

// A wave stays in the shading normal while it is this many pixel
// footprints long, and is gone at the first.
const SHADE_KEEP = vec2f(8.0, 24.0);
// The glint's normal keeps a wave only while it spans many more pixels than
// the shading's does: the sun picks out every wave it keeps as a bright
// streak, and waves a handful of pixels long would cover the open sea in an
// even, repeating pattern. What it drops widens the lobe into a soft sheen.
const GLINT_KEEP = vec2f(16.0, 48.0);
// The waves run straight across the whole chart, so where only the two or
// three longest are resolved their crests cross in a lattice. A slow warp
// of the waves' domain bends the crests: two long swells a component, at
// directions and lengths that share no period, displacing up to twice
// WARP_AMPLITUDE. The normal ignores the warp's own slope (amplitude times
// wavenumber, under 0.6 summed): it only makes the waves a little steeper
// or gentler in places. Sines, not noise: this runs for every pixel of
// water.
const WARP_AMPLITUDE = 7.0;
// kx, kz of each swell, radians per chart unit: 147 to 165 units long.
const WARP_X = mat2x2f(0.031, 0.022, -0.017, 0.035);
const WARP_Z = mat2x2f(-0.027, 0.029, 0.041, 0.012);
// Each wave's phase offset, waves.ts `WAVE_PHASE`.
const WAVE_PHASE = 2.399963;
// The glint's lobe on a calm, resolved surface: Phong on the reflected ray.
const SUN_SHININESS = 900.0;
// Water's reflectance head-on.
const F0 = 0.02;

// The wave field at a point, `footprint` chart units a pixel along the
// ground. Two normals: the shading one keeps each wave until it is a few
// pixels long, so the sky's reflection and the refraction stay calm instead
// of aliasing; the glint's lets waves go much sooner, and the slope they
// carried comes back as `variance`, which widens the sun's lobe (Toksvig).
// Up close every wave is in both and the glint is crisp; far out the
// glint's normal is flat and its lobe as wide as the whole spectrum's
// slopes: a soft sheen.
export struct Surface {
  normal: vec3f,
  glint: vec3f,
  variance: f32,
}

export fn slopeNormal(slope: vec2f) -> vec3f {
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

// Both normals in one pass over the spectrum: the phases are shared and only
// the slopes are needed, so a cosine per wave. The phase is waves.wgsl's
// (`sampleWaves`). `waves` are the chart's spectrum (look.ts `chartWaves`):
// kx, kz (radians per chart unit), angular frequency and amplitude;
// `strength` multiplies the amplitudes, 0 a flat plane.
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

// The analytic sky: the horizon's colour rising to the zenith's.
export fn sky(direction: vec3f, horizon: vec3f, zenith: vec3f) -> vec3f {
  let up = saturate(direction.y);
  return mix(horizon, zenith, sqrt(up));
}

// Schlick's Fresnel: how much of the sky the surface reflects toward a ray.
export fn fresnel(ray: vec3f, normal: vec3f) -> f32 {
  let facing = saturate(dot(-ray, normal));
  return F0 + (1.0 - F0) * pow(1.0 - facing, 5.0);
}

// The sun's glint: Phong on the reflected ray, its exponent lowered by
// the slope variance the glint's normal dropped. The reflected ray turns by
// twice the normal's tilt, so a variance σ² in slope spreads it by about
// 4σ²; the lobe is normalised, so a wider glint spreads its light rather
// than losing it.
export fn glint(ray: vec3f, surface: Surface, sun: vec3f) -> f32 {
  let reflected = reflect(ray, surface.glint);
  let spread = 1.0 / SUN_SHININESS + 4.0 * surface.variance;
  let shininess = 1.0 / spread;
  let lobe = pow(saturate(dot(reflected, sun)), shininess);
  return lobe * (shininess + 2.0) / (SUN_SHININESS + 2.0);
}

// The floor's light through `thickness` chart units of water, per channel
// (look.ts `waterOptics` derives the terms and `transmittanceOf` is this):
// the optical depth at `clarity` is `absorption`, the clearest channel's
// share of it, the brightness, grows as rho = (thickness / clarity)^power,
// and the rest, the tint, as rho^curve, so the hue turns fastest around
// `clarity` when `curve` is above 1.
export fn transmittance(thickness: f32, absorption: vec3f, clarity: f32, power: f32, curve: f32) -> vec3f {
  // Both powers of the depth from one logarithm.
  let depth = log2(max(thickness, 1e-6) / clarity);
  let rho = exp2(power * depth);
  let grey = min(min(absorption.x, absorption.y), absorption.z);
  let tint = (absorption - grey) * exp2(power * curve * depth);
  return exp(-(grey * rho + tint));
}

// How much of the water's own light stands at a point the sun reaches by
// `visible` (0–1, at the sea surface): all of it in the sun, `ambient` of
// it in the land's shadow.
export fn waterLight(visible: f32, ambient: f32) -> f32 {
  return mix(ambient, 1.0, saturate(visible));
}

// The floor's relief through the water's own colour, as a chart shades it:
// a multiplier, white on flat, open, sunlit floor so the legend means what
// it says, cool blue in the floor's shadow and on its lee faces, a little
// warm on faces turned to the sun. `normal` is the floor's, `sunlit` and
// `open` (ambient occlusion) its light map's; `deep` 0–1 calms it, as the
// sun barely reaches the deep floor.
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

// How much a step's riser catches the sun, 0–1: steep floor turned toward
// the sun, less in the deep, so each ring's edge is lit on its sunward side.
export fn riserRim(normal: vec3f, sun: vec3f, deep: f32) -> f32 {
  let riser = 1.0 - smoothstep(0.88, 0.985, normal.y);
  let toward = dot(normalize(normal.xz + vec2f(1e-5)), normalize(sun.xz + vec2f(1e-5)));
  return riser * smoothstep(0.1, 0.7, toward) * (1.0 - 0.6 * deep);
}

// A colour with its rim: brighter and a little paler, `rim` of the way.
export fn rimmed(color: vec3f, rim: f32) -> vec3f {
  return mix(color, color * 1.2 + vec3f(0.05, 0.06, 0.05), 0.5 * saturate(rim));
}

// The line along each sea step's lip: where the floor's up tips past the
// lip's, on the convex side only, `width` pixels at any distance (`span`
// is how much up changes across a pixel), heavier where the step breaks
// harder (`bend`, the floor's convexity).
const LIP_UP = 0.975;

export fn lipLine(up: f32, span: f32, bend: f32) -> f32 {
  let weight = smoothstep(0.04, 0.35, bend);
  let width = mix(0.6, 1.5, weight);
  let pixels = abs(up - LIP_UP) / max(span, 1e-4);
  return (1.0 - smoothstep(0.5 * width, 0.5 * width + 1.0, pixels)) * smoothstep(0.02, 0.22, bend);
}

// Caustics: two drifting ridge networks `size` across, bright where they
// cross, as light focused by the waves dances on the floor. Fades before
// the pattern would alias at `footprint` chart units a pixel.
export fn caustics(p: vec2f, size: f32, time: f32, footprint: f32) -> f32 {
  let a = 1.0 - abs(planarNoise(p / size + vec2f(0.12, 0.05) * time, 3u, 760u));
  let b = 1.0 - abs(planarNoise(p / (1.3 * size) + vec2f(-0.07, 0.1) * time, 3u, 761u));
  let resolved = 1.0 - smoothstep(0.03, 0.12, footprint / size);
  return pow(a * b, 5.0) * resolved;
}
