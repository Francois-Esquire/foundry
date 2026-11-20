import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { fineGaugeArt } from "@/model/fine-parts";
import { type ToneName, tones } from "@/model/palette";
import type { Detail } from "@/model/pixels";
import { gaugeArt } from "@/model/vitals";

export function Gauge({
  cells,
  detail = "fine",
  level,
  tone,
}: {
  readonly cells: number;
  readonly detail?: Detail;
  readonly level: number;
  readonly tone: ToneName;
}) {
  const rows = useMemo(
    () =>
      detail === "fine"
        ? fineGaugeArt(cells, level, tones[tone])
        : gaugeArt(cells, level, tones[tone]),
    [cells, detail, level, tone]
  );
  return <PixelArt rows={rows} />;
}
