import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { type Step, stepStripArt } from "@/model/steps";

export function StepStrip({
  steps,
  width,
}: {
  readonly steps: readonly Step[];
  readonly width: number;
}) {
  const rows = useMemo(() => stepStripArt(steps, width), [steps, width]);
  return <PixelArt rows={rows} />;
}
