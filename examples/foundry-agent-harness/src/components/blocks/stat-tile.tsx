import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { fineStatTileArt } from "@/model/fine-parts";
import { type ToneName, tones } from "@/model/palette";
import type { Detail } from "@/model/pixels";
import { statTileArt } from "@/model/vitals";

export function StatTile({
  detail = "fine",
  label,
  level,
  note,
  tone,
  width,
}: {
  readonly detail?: Detail;
  readonly label: string;
  readonly level: number;
  readonly note?: string;
  readonly tone: ToneName;
  readonly width: number;
}) {
  const rows = useMemo(() => {
    const tile = { detail: note, label, level, tone: tones[tone], width };
    return detail === "fine" ? fineStatTileArt(tile) : statTileArt(tile);
  }, [detail, label, level, note, tone, width]);
  return <PixelArt rows={rows} />;
}
