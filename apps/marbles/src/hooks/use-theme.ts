import { theme } from "~/components/ui/theme";

/**
 * Only `dashboard/terminal.tsx` still calls this; views import `theme`.
 * Delete it once that host reads the constant too.
 */
export function useTheme() {
  return theme;
}
