import { theme } from "./theme";

export function Tag({
  children,
  color = theme.colors.primary,
}: {
  readonly children: string;
  readonly color?: string;
}) {
  return (
    <text fg={color} flexShrink={0} wrapMode="none">
      {`[${children}]`}
    </text>
  );
}
