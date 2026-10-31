import { nativeTheme } from "electron";
import type { NativeTheme } from "./theme";

/** Electron's `nativeTheme`: its source also sets CSS `prefers-color-scheme`. */
export const electronNativeTheme: NativeTheme = {
  get dark() {
    return nativeTheme.shouldUseDarkColors;
  },
  onUpdated(listener) {
    nativeTheme.on("updated", listener);
    return () => {
      nativeTheme.off("updated", listener);
    };
  },
  setSource(source) {
    nativeTheme.themeSource = source;
  },
};
