/** How a screen reaches the application the shell opened. */
import { createContext, type ReactNode, useContext } from "react";
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
