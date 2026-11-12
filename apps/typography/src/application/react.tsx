/** How a screen reaches the application the shell opened. */
import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Application } from "./application";

const ApplicationContext = createContext<Application | undefined>(undefined);

export const ApplicationProvider = ({
  application,
  children,
}: {
  readonly application: Application;
  readonly children: ReactNode;
}) => <ApplicationContext value={application}>{children}</ApplicationContext>;

/** The open application: its commands, and the one session of each place a screen holds. */
export const useApplication = (): Application => {
  const application = useContext(ApplicationContext);
  if (!application) {
    throw new Error("useApplication needs an ApplicationProvider above it.");
  }
  return application;
};

/**
 * The model provider's key and the way to change it. One key for the open
 * application, so the places that call a model all show and use the same one.
 */
export const useProviderKey = (): readonly [
  key: string,
  setKey: (key: string) => void,
] => {
  const { providerKey } = useApplication().places;
  return [
    useSyncExternalStore(
      providerKey.subscribe,
      providerKey.getState,
      providerKey.getState
    ),
    providerKey.setState,
  ];
};

/** Where a pasted provider key is kept and sent, said beside the field it is typed into. */
export const KEY_HINT =
  "Kept in memory for this session only. It is never written to storage, and it is gone when the page reloads or closes. It is sent to fal with a request and to nothing else.";
