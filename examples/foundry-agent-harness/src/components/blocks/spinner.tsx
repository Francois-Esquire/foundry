import { useEffect, useState } from "react";
import { useTheme } from "@/hooks/use-theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function Spinner() {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % FRAMES.length),
      FRAME_MS
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <text fg={theme.colors.primary}>
      <b>{FRAMES[frame]}</b>
    </text>
  );
}
