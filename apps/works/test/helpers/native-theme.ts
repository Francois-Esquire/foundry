import type { NativeTheme } from "~/main/system/theme";

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
