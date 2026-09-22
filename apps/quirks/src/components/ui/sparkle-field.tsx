import { RGBA } from "@opentui/core";
import { useEffect, useState } from "react";
import { useTheme } from "~/hooks/use-theme";

import { createSparkles } from "./sparkle-geometry";

const SPARKLES = createSparkles();
const FRAME_MS = 200;

function shade(color: string, background: RGBA, brightness: number): RGBA {
  const [r, g, b] = RGBA.fromHex(color).toInts();
  const [br, bg, bb] = background.toInts();
  // Preblend each half-pixel so foreground opacity cannot mix with its lower neighbor.
  return RGBA.fromInts(
    Math.round(br + (r - br) * brightness),
    Math.round(bg + (g - bg) * brightness),
    Math.round(bb + (b - bb) * brightness)
  );
}

/** Brightness gives fixed silhouettes depth; staggered glints never blink off. */
export function SparkleField({
  width,
  height,
  paused = false,
}: {
  readonly width: number;
  readonly height: number;
  readonly paused?: boolean;
}) {
  const theme = useTheme();
  const background = RGBA.fromHex(theme.colors.background);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [paused]);
  return (
    <box
      height={height}
      id="splash:sparkles"
      left={0}
      overflow="hidden"
      position="absolute"
      top={0}
      width={width}
      zIndex={0}
    >
      {SPARKLES.map((sparkle) => {
        const phase =
          (tick * FRAME_MS) / (sparkle.period * 1000) + sparkle.offset;
        const shimmer = ((1 - Math.cos(phase * Math.PI * 2)) / 2) ** 2;
        const compact = width < 90 || height < 28;
        const shape = compact ? sparkle.compact : sparkle.shape;
        const brightness = sparkle.brightness + shimmer * sparkle.glint;
        const palette = {
          base: shade(
            sparkle.green ? theme.colors.success : theme.colors.primary,
            background,
            brightness
          ),
          empty: background,
          fill: shade(theme.colors.accent, background, brightness * 0.45),
          highlight: shade(
            sparkle.green ? theme.colors.accent : theme.colors.foreground,
            background,
            brightness
          ),
          shadow: shade(theme.colors.accent, background, brightness * 0.7),
        };
        return (
          <text
            height={shape.height}
            key={sparkle.id}
            left={Math.max(
              0,
              Math.min(
                width - shape.width,
                Math.round(width * sparkle.x - shape.width / 2)
              )
            )}
            position="absolute"
            selectable={false}
            top={Math.max(
              0,
              Math.min(
                height - shape.height,
                Math.round(height * sparkle.y - shape.height / 2)
              )
            )}
            width={shape.width}
            wrapMode="none"
          >
            {shape.pixels.map((pixel) => (
              <span
                bg={palette[pixel.background]}
                fg={palette[pixel.foreground]}
                key={pixel.id}
              >
                {pixel.text}
              </span>
            ))}
          </text>
        );
      })}
    </box>
  );
}
