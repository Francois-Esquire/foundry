import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";
import { SparkleField } from "~/components/ui/sparkle-field";
import { theme } from "~/components/ui/theme";

export interface Viewport {
  readonly height: number;
  readonly width: number;
}

export function SplashLayout({
  width,
  height,
  paused,
  onResize,
  card,
  overlay,
}: {
  readonly width: number;
  readonly height: number;
  readonly paused: boolean;
  readonly onResize: (viewport: Viewport) => void;
  readonly card: ReactNode;
  readonly overlay?: ReactNode;
}) {
  const measure = useCallback(
    function measureSplash(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box
      alignItems="center"
      backgroundColor={theme.colors.background}
      height="100%"
      justifyContent="center"
      onSizeChange={measure}
      width="100%"
    >
      <SparkleField height={height} paused={paused} width={width} />
      {card}
      {overlay}
    </box>
  );
}
