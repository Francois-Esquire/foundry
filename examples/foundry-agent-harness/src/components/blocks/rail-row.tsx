import { hud } from "@/model/palette";

export function RailRow({
  icon,
  title,
  value,
}: {
  readonly icon: string;
  readonly title: string;
  readonly value: string;
}) {
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={1} paddingX={2}>
      <text fg={hud.amber} flexShrink={0} wrapMode="none">
        {`${icon}  `}
        <b>{title}</b>
      </text>
      <box flexGrow={1} />
      <text fg={hud.dim} flexShrink={1} wrapMode="none">
        {value}
      </text>
    </box>
  );
}
