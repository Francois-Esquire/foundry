import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";
import { theme } from "~/components/ui/theme";

export function RunFilterNotice({ label }: { readonly label: string }) {
  return <text fg={theme.colors.info}>Run filter: {label} · x all runs</text>;
}

export function SearchBar({
  scope,
  query,
  editing,
  focused,
  onInput,
  onSubmit,
}: {
  readonly scope: string;
  readonly query: string;
  readonly editing: boolean;
  readonly focused: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  if (editing) {
    return (
      <box flexDirection="row" height={1}>
        <Text>Search {scope}: </Text>
        <TextInput
          flexGrow={1}
          focused={focused}
          onInput={onInput}
          onSubmit={onSubmit}
          value={query}
        />
        <Text>Enter apply · Esc clear</Text>
      </box>
    );
  }
  return query ? (
    <Text>
      Search {scope}: {query} · / edit · x clear
    </Text>
  ) : null;
}
