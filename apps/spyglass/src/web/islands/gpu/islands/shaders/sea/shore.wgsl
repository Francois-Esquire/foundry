// The shore at the water's surface: the surf where the swell breaks (the
// flow map's breaking), crests rolling ashore broken into patches with a
// line of foam at the water's edge; and the glow the pale sand under a
// beach gives back through the water; the wash where the swell meets a
// drop-off's wall, which has no glow; and the swash running up the sand. Pure: the composite owns the bindings.
import { planarNoise } from "../../../../shaders/noise/planar.wgsl";

export const FOAM = vec3f(0.97, 0.98, 0.96);

// The swash turns the crests over cells this many crest spacings across;
// the crests break into patches this many across, and froth this many.
const SWASH_CELLS = 2.5;
const PATCH_CELLS = 3.0;
const FROTH_CELLS = 0.35;
// A crest's foam: its front, the shoreward share of a spacing it rises
// over, and its tail, the share it trails seaward over.
const CREST_FRONT = 0.08;
const CREST_TAIL = 0.45;
// What the crests average to once they are too close to resolve.
const CREST_MEAN = 0.12;
// The crests fade out this many spacings off the water's edge.
const CREST_REACH = 4.0;
// The foam at the water's edge runs this share of a spacing out.
const EDGE_SHARE = 0.4;

// How much surf stands at `p`, `coast` chart units off the coast and
// `edge` off the water's edge, where the swell breaks by `breaking` (0–1):
// crests `spacing` apart that roll ashore at `speed`, each a sharp front
// with a frothy tail behind it, broken into patches and fading out to sea;
// and a line of foam at the edge. `footprint` is chart units a pixel.
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

// The wash on a wall, drawn as the sea stacks' foam is (debris/props.wgsl
// `fs_ring`): the swell does not break on the way in but meets the rock
// whole, so a crisp collar of foam hugs the wall and, each time a swell
// hits, a ring of foam spreads off it, parallel to the wall, and fades.
// The collar's width and each ring's, against the wash's `width`.
const WASH_COLLAR = 0.18;
const WASH_RING = 0.07;
// Rings in flight at once, a period apart over their spread.
const WASH_RINGS = 2u;
// The swells arrive unevenly along the wall, over cells this many widths
// across, by this share of a period; and the foam's edge wavers this
// share of a width over cells this many across.
const WASH_CELLS = 5.0;
const WASH_WANDER = 0.6;
const WASH_WAVER = 0.12;
const WAVER_CELLS = 1.5;
// What the rings average to once they are too thin to resolve.
const WASH_MEAN = 0.15;

// How much wash stands at `p`, `coast` chart units off a coast `wall` of a
// wall (0–1): the collar, and rings spreading `width` out every `period`
// seconds. `footprint` is chart units a pixel.
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

// The shoal: cream sand under the first few units of water, aqua as it
// deepens, around a beach out to `reach` off its coast. `steep` is how
// much of a drop-off the coast is (the paint map's alpha); `top` the
// highest level's depth, which the glow fades by.
const SHOAL_SAND = vec3f(0.95, 0.94, 0.82);
const SHOAL_AQUA = vec3f(0.7, 0.95, 0.9);

export struct Shoal {
  color: vec3f,
  // Light the sand gives back, added over the water.
  glow: vec3f,
}

export fn shoal(color: vec3f, depth: f32, coast: f32, reach: f32, top: f32, steep: f32, sunlit: f32, strength: f32) -> Shoal {
  let beach = step(-0.5, coast) * (1.0 - smoothstep(0.25 * reach, reach, coast)) * (1.0 - steep);
  let halo = beach * (1.0 - smoothstep(0.4 * top, 2.75 * top, depth)) * strength;
  let tint = mix(SHOAL_AQUA, SHOAL_SAND, 1.0 - smoothstep(0.15 * top, 1.3 * top, depth));
  return Shoal(mix(color, tint, saturate(halo * 0.55)), tint * halo * (0.03 + 0.1 * sunlit));
}

// The swash: what is left of a broken wave runs up the beach as a thin
// sheet and slides back, once a `period`. It rushes up over this share of
// the period and drains over the rest, and the sheet's edge is this high,
// chart units, laced with foam this high behind it.
const UPRUSH = 0.3;
const SHEET_EDGE = 0.015;
const LACE = 0.05;
// The lace's froth, over cells this many chart units across.
const LACE_CELL = 1.2;
// The swashes arrive unevenly along the shore, over cells this many chart
// units across, by this share of a period; their run-up varies by this share.
const SWASH_CELL = 9.0;
const SWASH_WANDER = 0.7;
const SWASH_VARY = 0.35;
// Wet sand dries from the top after the backwash: the share of the band
// the sheet left that is dry again as the next uprush begins.
const DRYING = 0.7;

export struct Swash {
  // How much of the ground is under the sheet, how much is foam lace at
  // its edge, and how wet the sand is, 0–1.
  sheet: f32,
  lace: f32,
  wet: f32,
}

// The swash on a beach at `p`, ground `height` above the water: a sheet
// that runs up to `reach` (chart units of height) every `period` seconds.
// `footprint` is chart units a pixel; the lace fades once unresolved.
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
