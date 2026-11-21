import type { NativeImage } from "@opentui/core";
import { hud } from "@/model/palette";
import { PORTRAIT_COLUMNS, PORTRAIT_ROWS } from "@/model/sprite";

export function Portrait({ image }: { readonly image: NativeImage | null }) {
  return (
    <box
      alignItems="center"
      flexShrink={0}
      height={PORTRAIT_ROWS}
      justifyContent="center"
      width={PORTRAIT_COLUMNS}
    >
      {image ? (
        <image height={PORTRAIT_ROWS} source={image} width={PORTRAIT_COLUMNS} />
      ) : (
        <text fg={hud.faint}>· · ·</text>
      )}
    </box>
  );
}
