/**
 * What screens reach besides the project itself: the imported fonts as CSS
 * families, and the font engine. Both are created once by the app and handed
 * down here, so a screen never constructs or imports an engine.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { FontBuilder } from "~/packaging/building";
import type { EngineClient, EngineStatus } from "~/packaging/engine/client";
import type { FaceId } from "~/typeface/face";
import type { BrowserFonts } from "./browser-fonts";
import { useWorkspaceState } from "./react";

export interface Services {
  readonly engine: EngineClient;
  readonly fonts: BrowserFonts;
}

const ServicesContext = createContext<Services | undefined>(undefined);

export function ServicesProvider({
  children,
  services,
}: {
  readonly children: ReactNode;
  readonly services: Services;
}) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

const useServices = (): Services => {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error("This screen needs a ServicesProvider above it.");
  }
  return services;
};

/**
 * The CSS family that sets text in a face's own source font, or undefined
 * when it has none. Pair it with `fontVariationSettings` for a variable face.
 */
export const useFontFamily = (
  faceId: FaceId | undefined
): string | undefined => {
  const { fonts } = useServices();
  // Read through the workspace state so the family appears with the import.
  return useWorkspaceState(
    useCallback(
      () => (faceId === undefined ? undefined : fonts.familyFor(faceId)),
      [faceId, fonts]
    )
  );
};

/** The font engine. Its first call starts it; `useEngineStatus` shows how it is doing. */
export const useFontBuilder = (): FontBuilder => useServices().engine;

export const useEngineStatus = (): EngineStatus => {
  const { engine } = useServices();
  return useSyncExternalStore(engine.subscribe, engine.status, engine.status);
};
