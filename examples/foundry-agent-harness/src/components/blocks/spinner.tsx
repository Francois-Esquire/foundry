import { useTheme } from "@/hooks/use-theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ frame }: { readonly frame: number }) {
  const theme = useTheme();
  return (
    <text fg={theme.colors.primary}>
      <b>{FRAMES[frame % FRAMES.length]}</b>
    </text>
  );
}
