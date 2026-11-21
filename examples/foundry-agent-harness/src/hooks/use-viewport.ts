import { useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import type { Size } from "@/model/screen";

export function useViewport(): {
  readonly measure: (size: Size) => void;
  readonly size: Size;
} {
  const terminal = useTerminalDimensions();
  const [measured, measure] = useState<Size>();
  return { measure, size: measured ?? terminal };
}
