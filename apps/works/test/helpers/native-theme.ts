import type { NativeTheme } from "~/main/system/theme";

/**
 * Electron's `nativeTheme` as main sees it: a forced source paints that
 * appearance, `system` paints the desktop's, and every change of either
 * emits `updated`.
 */
export function fakeNativeTheme(desktopDark = false) {
  const listeners = new Set<() => void>();
  let desktop = desktopDark;
  let source: "system" | "light" | "dark" = "system";
  const emit = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const native: NativeTheme = {
    get dark() {
      return source === "system" ? desktop : source === "dark";
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSource(next) {
      source = next;
      emit();
    },
  };
  return {
    /** The desktop switches appearance. */
    desktop(dark: boolean) {
      desktop = dark;
      emit();
    },
    native,
    get source() {
      return source;
    },
  };
}
