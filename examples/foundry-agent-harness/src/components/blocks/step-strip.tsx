import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { fineStepStripArt } from "@/model/fine-parts";
import type { Detail } from "@/model/pixels";
import { type Step, stepStripArt } from "@/model/steps";

export function StepStrip({
  detail = "fine",
  steps,
  width,
}: {
  readonly detail?: Detail;
  readonly steps: readonly Step[];
  readonly width: number;
}) {
  const rows = useMemo(
    () =>
      detail === "fine"
        ? fineStepStripArt(steps, width)
        : stepStripArt(steps, width),
    [detail, steps, width]
  );
  return <PixelArt rows={rows} />;
}
