import { Hint } from "@/components/blocks/hint";
import { ListRow } from "@/components/blocks/list-row";
import { useTheme } from "@/hooks/use-theme";
import type { Notes } from "@/model/thread";

export function NoteList({ notes }: { readonly notes: Notes | undefined }) {
  const theme = useTheme();
  if (!notes) {
    return <Hint>Nothing kept yet. Each goal is saved as one version.</Hint>;
  }
  return (
    <>
      <text>
        <b>Agent harness notes</b>
      </text>
      <Hint>{`version ${notes.version} · ${notes.versions} kept`}</Hint>
      <box flexDirection="column" marginTop={1}>
        {notes.files.map((file) => (
          <ListRow
            color={theme.colors.foreground}
            icon="▪"
            key={file.path}
            note={file.path}
          >
            {file.title}
          </ListRow>
        ))}
      </box>
    </>
  );
}
