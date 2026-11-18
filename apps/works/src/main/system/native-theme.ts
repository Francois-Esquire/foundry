import { nativeTheme } from "electron";
import type { NativeTheme } from "./theme";

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
