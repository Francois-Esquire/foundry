import { craterAperture } from "../codex/bindings";
import type { Landmark } from "../landmarks";

/** Fitted, engraved signs. The summit anchor remains the real file location. */
export function paintLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  strength: number,
  pixels: number
) {
  for (const landmark of landmarks) {
    const { file, footprint, radius, kind } = landmark;
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.beginPath();
    for (const [i, point] of footprint.entries()) {
      if (i) {
        ctx.lineTo(point.x, point.y);
      } else {
        ctx.moveTo(point.x, point.y);
      }
    }
    ctx.closePath();
    ctx.clip();
    ctx.translate(file.x, file.y);
    ctx.lineWidth = 0.7 / pixels;
    if (kind !== "crater") {
      paintSummit(ctx, radius);
    }
    if (landmark.change) {
      paintCrater(
        ctx,
        radius * craterAperture(landmark.change.file.commits),
        pixels
      );
    }
    ctx.restore();
  }
}

function paintSummit(ctx: CanvasRenderingContext2D, radius: number) {
  const r = radius;
  ctx.save();
  // The apex coincides with the file anchor, so a crater opens on the summit.
  ctx.translate(0, r * 0.33);
  ctx.scale(1, 0.6);
  // Unequal shoulders and a single broken ridge avoid a radial badge silhouette.
  ctx.beginPath();
  ctx.moveTo(-r * 0.9, r * 0.55);
  ctx.quadraticCurveTo(-r * 0.5, r * 0.25, -r * 0.3, r * 0.15);
  ctx.lineTo(0, -r * 0.55);
  ctx.lineTo(r * 0.38, r * 0.08);
  ctx.quadraticCurveTo(r * 0.6, r * 0.35, r * 0.92, r * 0.6);
  ctx.quadraticCurveTo(r * 0.1, r * 0.8, -r * 0.9, r * 0.55);
  const wash = ctx.createLinearGradient(-r * 0.5, -r * 0.3, r * 0.6, r * 0.7);
  wash.addColorStop(0, "#f3e1b6");
  wash.addColorStop(1, "#baa581");
  ctx.fillStyle = wash;
  ctx.fill();
  ctx.strokeStyle = "#7e6b50b0";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.55);
  ctx.lineTo(r * 0.08, r * 0.05);
  ctx.lineTo(-r * 0.05, r * 0.25);
  ctx.lineTo(r * 0.36, r * 0.6);
  ctx.lineTo(r * 0.92, r * 0.6);
  ctx.lineTo(r * 0.38, r * 0.08);
  ctx.closePath();
  ctx.fillStyle = "#89795780";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.55);
  ctx.lineTo(r * 0.08, r * 0.05);
  ctx.lineTo(-r * 0.05, r * 0.25);
  ctx.lineTo(r * 0.36, r * 0.6);
  ctx.strokeStyle = "#786348";
  ctx.stroke();
  ctx.restore();
}

function paintCrater(
  ctx: CanvasRenderingContext2D,
  aperture: number,
  pixels: number
) {
  ctx.beginPath();
  ctx.ellipse(0, 0, aperture, aperture * 0.62, -0.15, 0, Math.PI * 2);
  ctx.fillStyle = "#a6503e";
  ctx.fill();
  ctx.strokeStyle = "#67503e";
  ctx.lineWidth = 1 / pixels;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(
    0,
    aperture * 0.13,
    aperture * 0.62,
    aperture * 0.29,
    -0.15,
    0,
    Math.PI * 2
  );
  ctx.fillStyle = "#d08664";
  ctx.fill();
}
