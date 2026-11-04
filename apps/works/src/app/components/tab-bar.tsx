import { Tabs } from "radix-ui";
import { type ReactNode, useCallback } from "react";
import { cn } from "~/app/lib/cn";

interface TabBarItem<T extends string> {
  id: T;
  label: ReactNode;
}

export interface TabBarProps<T extends string> {
  /** The panels, as `TabPanel`s. */
  children: ReactNode;
  className?: string;
  /** Names the tab list for assistive technology. */
  label?: string;
  onChange: (id: T) => void;
  tabs: readonly TabBarItem<T>[];
  value: T;
}

/**
 * The underline tab bar: small-caps labels with an accent underline on the
 * active tab. The row scrolls sideways when there are more tabs than fit.
 * Arrow keys move between tabs, and each tab names its panel.
 */
export function TabBar<T extends string>({
  children,
  className,
  label,
  onChange,
  tabs,
  value,
}: TabBarProps<T>) {
  const select = useCallback(
    (next: string) => {
      const tab = tabs.find((candidate) => candidate.id === next);
      if (tab) {
        onChange(tab.id);
      }
    },
    [onChange, tabs]
  );
  return (
    <Tabs.Root onValueChange={select} value={value}>
      <Tabs.List
        aria-label={label}
        className={cn(
          "flex overflow-x-auto border-border/40 border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className
        )}
      >
        {tabs.map((tab) => (
          <Tabs.Trigger
            className="-mb-px shrink-0 border-transparent border-b-2 px-3 pt-1 pb-2.5 font-medium text-muted-foreground text-xs uppercase tracking-[0.06em] outline-none transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=active]:border-primary data-[state=active]:text-foreground"
            key={tab.id}
            value={tab.id}
          >
            {tab.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}

/** The panel of the tab whose id is its `value`. */
export const TabPanel = Tabs.Content;
