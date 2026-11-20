import { ease } from "../maps/frame.wgsl";

export struct Land {
  plateHeight: f32,
  rimWidth: f32,
  lipHeight: f32,
  lipWidth: f32,
  crownHeight: f32,
  crownWidth: f32,
}

export fn landHeight(land: Land, inland: f32, coast: f32) -> f32 {
  let rise = ease(0.0, land.rimWidth, inland);
  let lip = rise * (1.0 - ease(land.rimWidth, land.rimWidth + land.lipWidth, inland));
  let crown = land.crownHeight * rise * (1.0 - exp(-max(inland, 0.0) / max(land.crownWidth, 1e-3)));
  return mix(coast, land.plateHeight, rise) + land.lipHeight * lip + crown;
}
