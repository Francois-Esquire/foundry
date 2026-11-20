import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { finePortraitArt } from "@/model/fine-parts";
import type { Detail } from "@/model/pixels";
import { portraitArt } from "@/model/portrait";

export function PortraitBay({
  caption,
  detail = "fine",
  rows,
  width,
}: {
  readonly caption: string;
  readonly detail?: Detail;
  readonly rows: number;
  readonly width: number;
}) {
  const art = useMemo(
    () =>
      detail === "fine"
        ? finePortraitArt({ caption, rows, width })
        : portraitArt({ caption, rows, width }),
    [caption, detail, rows, width]
  );
  return <PixelArt rows={art} />;
}
