/**
 * What only a browser has for a screen: the imported fonts as CSS families,
 * and how the font engine is starting. A screen builds and reads fonts
 * through the application, never through here.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
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

export const useEngineStatus = (): EngineStatus => {
  const { engine } = useServices();
  return useSyncExternalStore(engine.subscribe, engine.status, engine.status);
};
