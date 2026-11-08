// The turf on the islands' tops: its colour, patched lush and dry over
// tens of units, clumped over a few, and bladed close up; the hummocks
// that tilt its normal so the light rolls over it; and its sheen, the
// pale glow a short pile throws back at a grazing eye. Every term fades
// before it falls under a pixel, so it never shimmers. Pure: the terrain
// owns the bindings and passes the colours in.
import { planarFbm, planarNoise } from "../../../../shaders/noise/planar.wgsl";

// Salts (shaders/README.md): 810–812 the patches, 813 the clumps, 814 the
// tufts, 815 the blades, 816 the hummocks, 819–820 the gusts, 821 the
// flutter, 822–823 the combing.
const PATCH_SALT = 810u;
const CLUMP_SALT = 813u;
const TUFT_SALT = 814u;
const BLADE_SALT = 815u;
const HUMMOCK_SALT = 816u;
const GUST_SALT = 819u;
const SQUALL_SALT = 820u;
const FLUTTER_SALT = 821u;
const COMB_SALT = 822u;

// Chart units across a patch, a clump, a tuft, a blade's streak and a
// hummock.
const PATCH = 26.0;
const CLUMP = 5.0;
const TUFT = 1.1;
const BLADE = 0.4;
const HUMMOCK = 6.0;

// A term is whole while a pixel is below this share of its size, and gone
// by the second.
const FADE = vec2f(0.35, 0.9);

fn detail(size: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(FADE.x, FADE.y, footprint / size);
}

// The turf's colour at `p` (chart x, y), between `lush` and `dry`. `edge`
// 0–1 is how near the plate's edge it grows, where it runs thinner and
// paler; `hollow` 0–1 how sheltered it lies, where it runs deeper green;
// `laid` 0–1 how flat the wind lays it, showing the blades' pale backs.
export fn grassColor(p: vec2f, lush: vec3f, dry: vec3f, edge: f32, hollow: f32, laid: f32, footprint: f32) -> vec3f {
  let patches = planarFbm(p / PATCH, 3, 0.5, 1u, PATCH_SALT);
  let dryness = saturate(0.45 + 0.9 * patches + 0.35 * edge - 0.4 * hollow);
  var color = mix(lush, dry, smoothstep(0.15, 0.85, dryness));
  let clumps = planarNoise(p / CLUMP, 1u, CLUMP_SALT) * detail(CLUMP, footprint);
  let tufts = planarNoise(p / TUFT, 1u, TUFT_SALT) * detail(TUFT, footprint);
  color *= (1.0 + 0.16 * clumps) * (1.0 + 0.2 * tufts);
  // Blades: streaks a little longer one way, light tips and dark roots.
  let streak = vec2f(p.x * 0.6 + p.y * 0.8, p.y * 0.6 - p.x * 0.8) / vec2f(BLADE, BLADE * 2.5);
  let blades = planarNoise(streak, 1u, BLADE_SALT) * detail(BLADE, footprint);
  color *= 1.0 + 0.28 * blades;
  // Standing in a lull it shows its deep side; laid by a gust, its backs.
  color *= mix(0.85, 1.0, laid);
  return mix(color, dry * 1.35, 0.5 * laid);
}

// The hummocks' slope at `p`: how far the turf's normal tilts in x and z,
// already faded by the footprint.
export fn grassTilt(p: vec2f, footprint: f32) -> vec2f {
  let fade = detail(HUMMOCK, footprint);
  if (fade <= 0.0) {
    return vec2f(0.0);
  }
  let step = 0.35;
  let q = p / HUMMOCK;
  let c = planarNoise(q, 1u, HUMMOCK_SALT);
  let dx = planarNoise(q + vec2f(step, 0.0), 1u, HUMMOCK_SALT) - c;
  let dz = planarNoise(q + vec2f(0.0, step), 1u, HUMMOCK_SALT) - c;
  return vec2f(dx, dz) / step * fade;
}

// The sheen's share at a surface facing `normal`, seen along `toEye`: the
// pile catching the light as the eye drops toward the ground.
export fn grassSheen(normal: vec3f, toEye: vec3f) -> f32 {
  let grazing = 1.0 - saturate(dot(normal, toEye));
  return grazing * grazing * grazing;
}

// A gust's front runs this many times wider across the wind than along it;
// the squalls, smaller, run faster than the gusts by the second.
const GUST_STRETCH = 2.5;
const SQUALL = vec2f(0.35, 1.6);
// The flutter's cell, chart units, and how fast it shivers.
const FLUTTER = 1.4;
const FLUTTER_RATE = 2.3;
// The combing: streaks the wind lays the turf in, chart units across and
// along, coarse then fine, and how fast they creep downwind.
const COMBS = array<vec2f, 2>(vec2f(1.3, 7.0), vec2f(0.45, 2.4));
const COMB_CREEP = 0.12;

// The streaks the wind combs the turf into at `p`, about −1–1: long down
// the wind, narrow across it, faded by their width.
fn combing(along: f32, side: f32, time: f32, speed: f32, footprint: f32) -> f32 {
  var total = 0.0;
  for (var i = 0u; i < 2u; i++) {
    let comb = COMBS[i];
    let q = vec2f((along - time * speed * COMB_CREEP) / comb.y, side / comb.x);
    total += planarNoise(q, 1u, COMB_SALT + i) * detail(comb.x, footprint) * (1.0 - 0.4 * f32(i));
  }
  return total;
}

// The wind over the turf at `p`, `time` seconds in: gusts blowing along
// `heading` (a unit chart x, y) at `speed` chart units a second, `gust`
// units along, with smaller squalls rolling through them and a shiver of
// flutter close up. xy: how far it tilts the turf's normal downwind, x and
// z; z: how flat it lays the blades, 0–1; w: the streaks it combs them
// into, about −1–1.
export fn grassWind(p: vec2f, heading: vec2f, time: f32, speed: f32, gust: f32, footprint: f32) -> vec4f {
  let across = vec2f(-heading.y, heading.x);
  let along = dot(p, heading);
  let side = dot(p, across);
  let gusts = planarFbm(vec2f(along - time * speed, side / GUST_STRETCH) / gust, 2, 0.5, 1u, GUST_SALT) * detail(gust, footprint);
  let squallSize = gust * SQUALL.x;
  let squalls = planarNoise(vec2f(along - time * speed * SQUALL.y, side / GUST_STRETCH) / squallSize, 1u, SQUALL_SALT) * detail(squallSize, footprint);
  let laid = smoothstep(-0.1, 0.75, gusts + 0.35 * squalls);
  let drift = (p - heading * time * speed * 0.5) / FLUTTER;
  let flutter = planarNoise(drift + across * sin(time * FLUTTER_RATE) * 0.3, 1u, FLUTTER_SALT) * detail(FLUTTER, footprint);
  let bend = 0.25 + 0.75 * laid;
  let comb = combing(along, side, time, speed, footprint);
  let lean = across * (flutter * 0.35 * (0.4 + laid) + comb * 0.3);
  return vec4f(heading * bend + lean, laid, comb);
}
