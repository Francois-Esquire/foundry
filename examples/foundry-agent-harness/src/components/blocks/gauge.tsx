import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { type ToneName, tones } from "@/model/palette";
import { gaugeArt } from "@/model/vitals";

export function Gauge({
  cells,
  level,
  tone,
}: {
  readonly cells: number;
  readonly level: number;
  readonly tone: ToneName;
}) {
  const rows = useMemo(
    () => gaugeArt(cells, level, tones[tone]),
    [cells, level, tone]
  );
  return <PixelArt rows={rows} />;
}
