import { KeyValue } from "~/components/ui/key-value";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export interface HelpSection {
  readonly items: readonly { readonly key: string; readonly value: string }[];
  readonly title: string;
}

export function KeyboardHelp({
  active = true,
  sections,
}: {
  readonly active?: boolean;
  readonly sections: readonly HelpSection[];
}) {
  return (
    <Panel
      active={active}
      scrollable={active}
      title="Keyboard help · Esc or ? closes"
    >
      {sections.map((section) => (
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
