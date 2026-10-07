import { useEffect, useState } from "react";
import { theme } from "~/components/ui/theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function LoadingIndicator({ label }: { readonly label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % FRAMES.length),
      100
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <text fg={theme.colors.primary}>
      {FRAMES[frame]} {label}
    </text>
  );
}
