import { hud, type ToneName, tones } from "@/model/palette";

export function Chip({
  children,
  ground = hud.screen,
  tone,
}: {
  readonly children: string;
  readonly ground?: string;
  readonly tone: ToneName;
}) {
  const look = tones[tone];
  return (
    <text flexShrink={0} wrapMode="none">
      <span bg={ground} fg={look.lit}>
        ▐
      </span>
      <span bg={look.lit} fg={hud.shade}>
        <b>{children}</b>
      </span>
      <span bg={ground} fg={look.lit}>
        ▌
      </span>
    </text>
  );
}
