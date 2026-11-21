import type { ReactNode } from "react";
import { useTheme } from "@/hooks/use-theme";

export function Hint({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <text fg={theme.colors.mutedForeground}>{children}</text>;
}
