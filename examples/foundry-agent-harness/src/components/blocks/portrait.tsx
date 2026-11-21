import type { NativeImage } from "@opentui/core";
import { hud } from "@/model/palette";
import { PORTRAIT_SIZES, type PortraitSize } from "@/model/sprite";

export function Portrait({
  image,
  size = "large",
}: {
  readonly image: NativeImage | null;
  readonly size?: PortraitSize;
}) {
  const { columns, rows } = PORTRAIT_SIZES[size];
  return (
    <box
      alignItems="center"
      flexShrink={0}
      height={rows}
      justifyContent="center"
      width={columns}
    >
      {image ? (
        <image height={rows} source={image} width={columns} />
      ) : (
        <text fg={hud.faint}>· · ·</text>
      )}
    </box>
  );
}
