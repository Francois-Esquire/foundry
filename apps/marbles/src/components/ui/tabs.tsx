// Adapted from termcn's OpenTUI Tabs.
import type { ReactNode } from "react";
import { Action } from "~/components/action";

export function Tabs<T extends string>({
  tabs,
  activeTab,
  onTabChange,
}: {
  readonly tabs: readonly {
    readonly key: T;
    readonly label: string;
    readonly content: ReactNode;
  }[];
  readonly activeTab: T;
  readonly onTabChange: (key: T) => void;
}) {
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <box flexDirection="row" flexWrap="wrap" gap={2}>
        {tabs.map((tab) => (
          <Action
            active={tab.key === activeTab}
            id={`tab:${tab.key}`}
            key={tab.key}
            label={tab.label}
            onAction={onTabChange}
            value={tab.key}
          />
        ))}
      </box>
      {tabs.find((tab) => tab.key === activeTab)?.content}
    </box>
  );
}
