import "./tabs.css";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
} from "react";

export interface TabItem<Id extends string> {
  readonly disabled?: boolean;
  readonly id: Id;
  readonly label: string;
}

interface TabsProps<Id extends string> {
  /** The panel of the tab that is on. */
  readonly children: ReactNode;
  readonly label: string;
  readonly onChange: (id: Id) => void;
  readonly tabs: readonly TabItem<Id>[];
  readonly value: Id;
}

const neighbour = <Id extends string>(
  tabs: readonly TabItem<Id>[],
  from: Id,
  key: string
): TabItem<Id> | undefined => {
  const open = tabs.filter((tab) => !tab.disabled);
  const index = open.findIndex((tab) => tab.id === from);
  switch (key) {
    case "ArrowRight":
      return open[(index + 1) % open.length];
    case "ArrowLeft":
      return open[(index - 1 + open.length) % open.length];
    case "Home":
      return open[0];
    case "End":
      return open.at(-1);
    default:
      return;
  }
};

/**
 * Views that share one space. Arrow keys move between tabs and switch the
 * panel at once; Home and End go to the first and last.
 */
export function Tabs<Id extends string>({
  children,
  label,
  onChange,
  tabs,
  value,
}: TabsProps<Id>) {
  const base = useId();
  const tabId = useCallback((id: Id) => `${base}-tab-${id}`, [base]);
  const panelId = `${base}-panel`;

  const choose = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const chosen = tabs.find(
        (tab) => tab.id === event.currentTarget.dataset.tab
      );
      if (chosen) {
        onChange(chosen.id);
      }
    },
    [onChange, tabs]
  );

  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const target = neighbour(tabs, value, event.key);
      if (!target) {
        return;
      }
      event.preventDefault();
      onChange(target.id);
      document.getElementById(tabId(target.id))?.focus();
    },
    [onChange, tabId, tabs, value]
  );

  return (
    <div className="ty-tabs">
      <div aria-label={label} className="ty-tabs-list" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls={panelId}
            aria-selected={tab.id === value}
            className="ty-label ty-tab"
            data-tab={tab.id}
            disabled={tab.disabled}
            id={tabId(tab.id)}
            key={tab.id}
            onClick={choose}
            onKeyDown={pressKey}
            role="tab"
            tabIndex={tab.id === value ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={tabId(value)}
        className="ty-tabs-panel"
        id={panelId}
        role="tabpanel"
      >
        {children}
      </div>
    </div>
  );
}
