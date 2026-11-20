import { createContext, useContext, useEffect } from "react";

const FocusContext = createContext<((id: string) => void) | undefined>(
  undefined
);

export const FormFocusProvider = FocusContext.Provider;

export function useFormFocus(id: string) {
  const reveal = useContext(FocusContext);
  useEffect(() => {
    const timer = setTimeout(() => reveal?.(id), 20);
    return () => clearTimeout(timer);
  }, [id, reveal]);
}
