import type { WorksWindowBridge } from "~/shared/window-bridge";

declare global {
  interface Window {
    worksWindow: WorksWindowBridge;
  }
}
