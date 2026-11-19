/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { ReactNode } from "react";

import { useTheme } from "@/hooks/use-theme";
import type { BorderStyle } from "@/components/ui/types";

export interface Tab {
  key: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  activeTab?: string;
  onTabChange?: (key: string) => void;
  borderColor?: string;
  borderStyle?: BorderStyle;
  separator?: string;
  tabBarPaddingX?: number;
  paddingX?: number;
  paddingY?: number;
}

export const Tabs = ({
  tabs,
  defaultTab,
  activeTab: controlledTab,
  onTabChange,
  borderColor,
  borderStyle = "single",
  separator = " │ ",
  tabBarPaddingX = 2,
  paddingX = 1,
  paddingY = 0,
}: TabsProps) => {
  const theme = useTheme();
  const [internalTab, setInternalTab] = useState(
    defaultTab ?? tabs[0]?.key ?? ""
  );
  const activeKey = controlledTab ?? internalTab;
  const activeIndex = tabs.findIndex((t) => t.key === activeKey);

  const resolvedBorderColor = borderColor ?? theme.colors.border;

  const switchTab = (nextKey: string | undefined) => {
    if (!nextKey || nextKey === activeKey) {
      return;
    }
    if (onTabChange) {
      onTabChange(nextKey);
    } else {
      setInternalTab(nextKey);
    }
  };

  useKeyboard((key) => {
    if (key.name === "tab") {
      const step = key.shift ? tabs.length - 1 : 1;
      switchTab(tabs[(activeIndex + step) % tabs.length]?.key);
    }
  });

  const activeTab = tabs.find((t) => t.key === activeKey);

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexDirection="row"
        paddingLeft={tabBarPaddingX}
        paddingRight={tabBarPaddingX}
        gap={0}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.key === activeKey;
          return (
            <box flexDirection="row" key={tab.key}>
              <text
                fg={
                  isActive ? theme.colors.primary : theme.colors.mutedForeground
                }
              >
                {isActive ? (
                  <b>
                    <u>{tab.label}</u>
                  </b>
                ) : (
                  tab.label
                )}
              </text>
              {idx < tabs.length - 1 && (
                <text fg={resolvedBorderColor}>{separator}</text>
              )}
            </box>
          );
        })}
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        borderStyle={borderStyle}
        borderColor={resolvedBorderColor}
        paddingLeft={paddingX}
        paddingRight={paddingX}
        paddingTop={paddingY}
        paddingBottom={paddingY}
      >
        {activeTab?.content}
      </box>
    </box>
  );
};
