import { useTheme } from "~/hooks/use-theme";

export function StatusLabel({ status }: { readonly status: string }) {
  const theme = useTheme();
  let color = theme.colors.mutedForeground;
  if (status === "running") {
    color = theme.colors.info;
  }
  if (status === "complete") {
    color = theme.colors.success;
  }
  if (status === "failed") {
    color = theme.colors.error;
  }
  return <text fg={color}>{status}</text>;
}
