// The sea's flow: how a swell from far away arrives at each coast, where it
// breaks, which way the broken water runs, and the sediment it stirs. The
// physics, pure, for the flow map's kernel (maps/flow.wgsl), which owns the
// bindings, the march and the taps.
import { ease } from "../maps/frame.wgsl";

// The swell, as the kernel's uniforms hold it. Chart units and seconds.
export struct Swell {
  // Unit, chart x and y: the way the swell travels.
  heading: vec2f,
  // Crest to crest.
  length: f32,
  // A wave breaks where the floor is shallower than this: about 1.3 times
  // the swell's height.
  breakDepth: f32,
  // The transport at full breaking: the breaker's speed, sqrt(g · depth)
  // at the break point.
  speed: f32,
  // How far back along the transport the sediment's taps reach.
  drift: f32,
}

// The width of a shadow's diffracted edge, as a share of the first Fresnel
// zone, sqrt(length · range): a long swell behind a near island wraps in
// over a wide edge, a short one behind a far island leaves a crisp shadow.
const DIFFRACTION = 0.5;
// Breaking eases in from `breakDepth` and is full at this share of it, so
// the surf zone's seaward edge is a soft depth contour.
const BREAK_FULL = 0.5;
// Near the waterline the swash runs up and back: what is left of the
// transport turns along the shore, keeping this share of its shoreward
// part where the floor is dry.
const SWASH_KEEP = 0.2;

// The width of a shadow's edge `range` behind an obstacle, chart units.
// The kernel reads the obstacle's clearance averaged over about this width
// too: an islet smaller than it averages out to open water, and the swell
// wraps round it as diffraction does.
export fn diffractionEdge(swell: Swell, range: f32) -> f32 {
  return DIFFRACTION * sqrt(swell.length * max(range, 0.0));
}

// How much swell gets past an obstacle at `clearance` (the distance to the
// nearest coast, negative on land) with a shadow edge `edge` wide: half at
// the obstacle's edge, more or less by the clearance against the edge.
export fn diffracted(clearance: f32, edge: f32) -> f32 {
  return saturate(0.5 + clearance / max(edge, 1e-4));
}

// The share of the arriving swell breaking at `depth`, for `arriving` 0–1
// of it: none deeper than the break depth, all of it in the shallows, none
// on land.
export fn breaking(swell: Swell, depth: f32, arriving: f32) -> f32 {
  if (depth <= 0.0) {
    return 0.0;
  }
  return arriving * (1.0 - ease(BREAK_FULL * swell.breakDepth, swell.breakDepth, depth));
}

// The heading turned by refraction at `depth`, `upslope` the unit direction
// toward shallower water. A wave feels the floor once the depth is under
// half its length, and slows as the square root of the depth, so its crest
// turns toward the shallows: Snell's law keeps sin(angle) / speed, with the
// angle measured from `upslope`. A swell heading away from this shore
// arrives only by wrapping around it; it turns shoreward as the floor
// rises all the same.
export fn refracted(swell: Swell, upslope: vec2f, depth: f32) -> vec2f {
  let along = vec2f(-upslope.y, upslope.x);
  let toward = dot(swell.heading, upslope);
  let ratio = sqrt(saturate(depth / max(0.5 * swell.length, 1e-4)));
  let sine = dot(swell.heading, along) * ratio;
  let cosine = sqrt(max(1.0 - sine * sine, 0.0));
  let shoreward = select(mix(toward, cosine, 1.0 - ratio), cosine, toward >= 0.0);
  let turned = upslope * shoreward + along * sine;
  return turned / max(length(turned), 1e-4);
}

// The share of a swell arriving with `heading` that reaches the shore
// whose shallows lie toward `upslope`: the cosine of its incidence, as the
// energy it carries onto each unit of coast. Swell heading away from a
// shore (round an island's corner, past its lee) broke where it came from,
// not here.
export fn incidence(heading: vec2f, upslope: vec2f) -> f32 {
  return max(dot(heading, upslope), 0.0);
}

// The broken water's direction from the refracted heading: shoreward
// through the surf, turned along the shore where the floor is nearly dry.
export fn swash(swell: Swell, heading: vec2f, upslope: vec2f, depth: f32) -> vec2f {
  let dry = 1.0 - ease(0.0, BREAK_FULL * swell.breakDepth, depth);
  return heading - upslope * dot(heading, upslope) * (1.0 - SWASH_KEEP) * dry;
}

// The shoal's stirred sediment at `depth`, 0–1: breaking times shallowness.
export fn stirred(swell: Swell, depth: f32, arriving: f32) -> f32 {
  let shallow = 1.0 - saturate(depth / max(swell.breakDepth, 1e-4));
  return breaking(swell, depth, arriving) * shallow;
}
