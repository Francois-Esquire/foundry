import { hud, type ToneName, tones } from "@/model/palette";

export function Slab({
  children,
  detail,
  label,
  tone,
}: {
  readonly children: string;
  readonly detail?: string;
  readonly label: string;
  readonly tone: ToneName;
}) {
  const look = tones[tone];
  return (
    <box
      backgroundColor={hud.slab}
      flexDirection="row"
      flexShrink={0}
      height={1}
    >
      <text flexShrink={0} wrapMode="none">
        <span bg={look.deep} fg={look.lit}>
          ▌
        </span>
        <span bg={look.deep} fg={look.glow}>
          <b>{`${label} `}</b>
        </span>
        <span bg={hud.slab} fg={look.deep}>
          ▌
        </span>
      </text>
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <text bg={hud.slab} fg={hud.text} wrapMode="none">
          {children}
        </text>
      </box>
      {detail ? (
        <text bg={hud.slab} fg={hud.dim} flexShrink={0}>{` ${detail} `}</text>
      ) : null}
    </box>
  );
}
