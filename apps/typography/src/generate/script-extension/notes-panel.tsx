import type { MadeExtension } from "~/generation/script-extension/extend";
import { weightNotes } from "./weight-notes";

interface NotesPanelProps {
  readonly findings: MadeExtension;
}

/** The height rule the letters were sized by, how their weight came out, and the run's own notes. */
export function NotesPanel({ findings }: NotesPanelProps) {
  const { lines, notes } = findings;
  return (
    <div className="ty-generate-stack">
      <h3 className="ty-label">Size and weight</h3>
      <p className="ty-extension-measure">{lines.rule}</p>
      <ul className="ty-extension-list" data-extension-weight="">
        {weightNotes(findings).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <p className="ty-extension-measure">
        The rule matches the size of the new letters to the face. It does not
        match their weight: the weight is what these figures say.
      </p>
      <h3 className="ty-label">Notes from the run</h3>
      {notes.length > 0 ? (
        <ul className="ty-extension-list" data-extension-notes="">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p>The run reported no notes.</p>
      )}
    </div>
  );
}
