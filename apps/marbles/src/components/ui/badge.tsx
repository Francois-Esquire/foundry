import { RGBA } from "@opentui/core";
import { theme } from "./theme";

function linear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function badgeForeground(background: string): string {
  const [red, green, blue] = RGBA.fromHex(background).toInts();
  const luminance =
    0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return luminance >= 0.179 ? "#000000" : "#ffffff";
}

export function Badge({
  children,
  padded = true,
  variant,
}: {
  readonly children: string;
  readonly padded?: boolean;
  readonly variant: "error" | "warning";
}) {
  const { colors } = theme;
  const background = colors[variant];
  return (
    <text
      bg={background}
      fg={badgeForeground(background)}
      flexShrink={0}
      wrapMode="none"
    >
      <strong>{padded ? ` ${children} ` : children}</strong>
    </text>
  );
}
