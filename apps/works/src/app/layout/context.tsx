import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/app/lib/cn";

interface LayoutContextValue {
  setSubNavActive: (active: boolean) => void;
  setSubNavSlotEl: (el: HTMLElement | null) => void;
  /** True while a page has a non-collapsed SubNav mounted. */
  subNavActive: boolean;
  subNavSlotEl: HTMLElement | null;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

function useLayout(): LayoutContextValue {
  const context = use(LayoutContext);
  if (context === null) {
    throw new Error("Layout components must be inside LayoutProvider");
  }
  return context;
}

/** Owned by MainLayout, not the consumer. */
export function LayoutProvider({ children }: PropsWithChildren) {
  const [subNavSlotEl, setSubNavSlotEl] = useState<HTMLElement | null>(null);
  const [subNavActive, setSubNavActive] = useState(false);
  const value = useMemo(
    () => ({ setSubNavActive, setSubNavSlotEl, subNavActive, subNavSlotEl }),
    [subNavActive, subNavSlotEl]
  );

  return <LayoutContext value={value}>{children}</LayoutContext>;
}

/** Rendered by MainLayout between the sidebar and the content. */
export function SubNavSlot({ className }: { className?: string }) {
  const { setSubNavSlotEl, subNavActive } = useLayout();
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      setSubNavSlotEl(el);
    },
    [setSubNavSlotEl]
  );

  return (
    <div
      className={cn("shrink-0", !subNavActive && "hidden", className)}
      ref={ref}
    />
  );
}

/**
 * Pages render this to inject content into the slot. `collapsed` is owned by
 * the page so the toggle is per instance.
 */
export function SubNav({
  children,
  collapsed = false,
}: {
  children: ReactNode;
  collapsed?: boolean;
}) {
  const { subNavSlotEl, setSubNavActive } = useLayout();

  useEffect(() => {
    setSubNavActive(!collapsed);
    return () => {
      setSubNavActive(false);
    };
  }, [setSubNavActive, collapsed]);

  if (subNavSlotEl === null || collapsed) {
    return null;
  }

  return createPortal(children, subNavSlotEl);
}
