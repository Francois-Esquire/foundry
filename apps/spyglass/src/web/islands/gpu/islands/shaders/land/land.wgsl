// The land's profile: the rim rising from the coast to the plate, and the
// lip, a band that peaks where the rim ends and fades over `lipWidth`, so
// the plate's edge reads as a cut sheet; then the crown, the plate swelling
// inland like a bun's top, steep near the lip and flattening out, so a
// small islet is a low dome and a big island a plump tableland. Pure: the height map bakes it per
// texel, and the terrain rebuilds it at its vertices from the height map's
// smooth inputs, so a cliff steeper than a texel stays smooth up close.
import { ease } from "../maps/frame.wgsl";

export struct Land {
  plateHeight: f32,
  rimWidth: f32,
  lipHeight: f32,
  lipWidth: f32,
  // The crown's most height over the plate, and the distance inland over
  // which it rises most of the way (1 − 1/e of it).
  crownHeight: f32,
  crownWidth: f32,
}

// `inland` of the coast (negative at sea), the floor at the coast `coast`.
export fn landHeight(land: Land, inland: f32, coast: f32) -> f32 {
  let rise = ease(0.0, land.rimWidth, inland);
  let lip = rise * (1.0 - ease(land.rimWidth, land.rimWidth + land.lipWidth, inland));
  let crown = land.crownHeight * rise * (1.0 - exp(-max(inland, 0.0) / max(land.crownWidth, 1e-3)));
  return mix(coast, land.plateHeight, rise) + land.lipHeight * lip + crown;
}
