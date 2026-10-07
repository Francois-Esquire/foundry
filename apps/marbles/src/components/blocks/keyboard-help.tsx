import { KeyValue } from "~/components/ui/key-value";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { helpSections } from "~/views/dashboard-commands";

/** Every key binding, from the same table that handles the keys. */
export function KeyboardHelp({ active = true }: { readonly active?: boolean }) {
  return (
    <Panel
      active={active}
      scrollable={active}
      title="Keyboard help · Esc or ? closes"
    >
      {helpSections().map((section) => (
        <box flexDirection="column" flexShrink={0} key={section.title}>
          <text fg={theme.colors.primary}>
            <strong>{section.title}</strong>
          </text>
          <KeyValue items={section.items} />
        </box>
      ))}
      <Text>
        Mouse: open row details, toggle branch arrows, switch inspector tabs, or
        follow breadcrumbs.
      </Text>
    </Panel>
  );
}
