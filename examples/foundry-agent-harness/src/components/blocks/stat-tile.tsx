import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { type ToneName, tones } from "@/model/palette";
import { statTileArt } from "@/model/vitals";

export function StatTile({
  detail,
  label,
  level,
  tone,
  width,
}: {
  readonly detail?: string;
  readonly label: string;
  readonly level: number;
  readonly tone: ToneName;
  readonly width: number;
}) {
  const rows = useMemo(
    () => statTileArt({ detail, label, level, tone: tones[tone], width }),
    [detail, label, level, tone, width]
  );
  return <PixelArt rows={rows} />;
}
