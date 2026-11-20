import { InputRow } from "~/components/ui/input-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

const EDIT_HINT = "Enter apply · Esc clear";

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
      <InputRow
        focused={focused}
        hint={EDIT_HINT}
        labels={[`Search ${scope}:`]}
        onInput={onInput}
        onSubmit={onSubmit}
        value={query}
      />
    );
  }
  return query ? (
    <Text>
      Search {scope}: {query} · / edit · x clear
    </Text>
  ) : null;
}
