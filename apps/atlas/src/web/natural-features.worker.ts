import { naturalFeatures } from "./natural-features";

globalThis.onmessage = (
  event: MessageEvent<Parameters<typeof naturalFeatures>>
) => {
  globalThis.postMessage(naturalFeatures(...event.data));
};
