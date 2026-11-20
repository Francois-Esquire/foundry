import { useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { portraitArt } from "@/model/portrait";

export function PortraitBay({
  caption,
  rows,
  width,
}: {
  readonly caption: string;
  readonly rows: number;
  readonly width: number;
}) {
  const art = useMemo(
    () => portraitArt({ caption, rows, width }),
    [caption, rows, width]
  );
  return <PixelArt rows={art} />;
}
