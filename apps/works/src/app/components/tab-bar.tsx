import { type ReactNode, useCallback } from "react";
import { cn } from "~/app/lib/cn";

interface TabBarItem<T extends string> {
  id: T;
  label: ReactNode;
}

export interface TabBarProps<T extends string> {
  className?: string;
  onChange: (id: T) => void;
  tabs: readonly TabBarItem<T>[];
  value: T;
}

/**
 * The underline tab bar: small-caps labels with an accent underline on the
 * active tab. The row scrolls sideways when there are more tabs than fit.
 */
export function TabBar<T extends string>({
  className,
  onChange,
  tabs,
  value,
}: TabBarProps<T>) {
  return (
    <div
      className={cn(
        "flex overflow-x-auto border-border/40 border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      role="tablist"
    >
      {tabs.map((tab) => (
        <TabButton
          active={tab.id === value}
          id={tab.id}
          key={tab.id}
          label={tab.label}
          onSelect={onChange}
        />
      ))}
    </div>
  );
}

function TabButton<T extends string>({
  active,
  id,
  label,
  onSelect,
}: {
  active: boolean;
  id: T;
  label: ReactNode;
  onSelect: (id: T) => void;
}) {
  const handleClick = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  return (
    <button
      aria-selected={active}
      className={cn(
        "-mb-px shrink-0 border-b-2 px-3 pt-1 pb-2.5 font-medium text-xs uppercase tracking-[0.06em] outline-none transition-colors focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
      onClick={handleClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}
