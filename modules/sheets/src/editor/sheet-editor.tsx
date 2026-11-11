import {
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  addressOf,
  type CellPosition,
  type CellReference,
} from "../workbook/address";
import { Grid } from "./grid";
import { usePending } from "./pending";
import type { EditorSession, WorkbookView } from "./session";

/** A request to edit the selected cell, optionally starting from a typed key. */
interface EditRequest {
  readonly initial?: string;
}

/** The sheet a new name is typed for. */
interface SheetTarget {
  readonly sheet: string;
}

interface SheetEditorProps {
  dirty: boolean;
  saving: boolean;
  session: EditorSession;
  view: WorkbookView;
  writable: boolean;
}

/**
 * The open workbook: its sheet tabs, the selected cell's contents and the
 * grid. Contents typed for a cell, and a name typed for a sheet, are held
 * here with the cell or sheet they were typed for, so a save or reload
 * underneath never moves them and they outlive the fields showing them.
 * If that sheet disappears (renamed or removed elsewhere), the text is
 * kept and shown until the user discards it; it is never applied anywhere
 * else, and nothing typed afterwards replaces it.
 */
export function SheetEditor({
  dirty,
  saving,
  session,
  view,
  writable,
}: SheetEditorProps) {
  const [chosenSheet, setChosenSheet] = useState("");
  const [selected, setSelected] = useState<CellPosition>({ column: 0, row: 0 });
  const [request, setRequest] = useState<EditRequest | null>(null);
  const {
    current: currentContents,
    discard: discardContents,
    drop: dropContents,
    pending: contents,
    renamed: renamedContents,
    type: typeContents,
  } = usePending<CellReference>(session);
  const {
    current: currentName,
    discard: discardName,
    drop: dropName,
    pending: naming,
    type: typeName,
  } = usePending<SheetTarget>(session);
  const grid = useRef<HTMLDivElement>(null);
  const sheet = view.sheets.includes(chosenSheet)
    ? chosenSheet
    : (view.sheets[0] ?? "");
  const cell = addressOf(selected);
  const stranded = contents?.stranded ? contents : null;
  const typed =
    contents &&
    !contents.stranded &&
    contents.target.sheet === sheet &&
    contents.target.cell === cell
      ? contents.text
      : null;
  const strandedName = naming?.stranded ? naming : null;
  const typedName =
    naming && !naming.stranded && naming.target.sheet === sheet
      ? naming.text
      : null;

  useEffect(() => {
    if (!(dirty || contents || naming)) {
      return;
    }
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, contents, naming]);

  const select = useCallback(
    (position: CellPosition) => {
      dropContents();
      setRequest(null);
      setSelected(position);
    },
    [dropContents]
  );
  const choose = useCallback(
    (name: string) => {
      dropContents();
      dropName();
      setRequest(null);
      setChosenSheet(name);
    },
    [dropContents, dropName]
  );
  const startEditing = useCallback(
    (initial?: string) => {
      // Editing would replace the stranded text, so it waits for a discard.
      if (!currentContents()?.stranded) {
        setRequest({ initial });
      }
    },
    [currentContents]
  );
  const focusGrid = useCallback(() => {
    grid.current
      ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      ?.focus();
  }, []);
  const type = useCallback(
    (text: string) => typeContents({ cell, sheet }, text),
    [cell, sheet, typeContents]
  );
  /** Enters pending text in its own cell. False when it stays pending. */
  const enter = useCallback((): boolean => {
    const entry = currentContents();
    if (!entry) {
      return true;
    }
    const { workbook } = session.getSnapshot();
    if (entry.stranded || !workbook) {
      return false;
    }
    const entered =
      workbook.contents(entry.target) === entry.text ||
      session.apply({ ...entry.target, contents: entry.text, kind: "enter" });
    if (entered) {
      discardContents();
    }
    return entered;
  }, [session, currentContents, discardContents]);
  const typeSheetName = useCallback(
    (text: string) => typeName({ sheet }, text),
    [sheet, typeName]
  );
  const addSheet = useCallback(() => {
    if (session.apply({ kind: "add-sheet" })) {
      choose(session.getSnapshot().workbook?.sheets.at(-1) ?? "");
    }
  }, [session, choose]);
  /** Gives the typed name to the sheet it was typed for, never another. */
  const renameSheet = useCallback(() => {
    const entry = currentName();
    if (!entry || entry.stranded) {
      return;
    }
    const pendingContents = currentContents();
    const to = entry.text;
    if (
      session.apply({ kind: "rename-sheet", sheet: entry.target.sheet, to })
    ) {
      // Renaming its sheet stranded the entry; it was applied, not lost.
      discardName();
      if (pendingContents?.target.sheet === entry.target.sheet) {
        renamedContents(pendingContents, to);
      }
      setRequest(null);
      setChosenSheet(to);
    }
  }, [session, currentName, discardName, currentContents, renamedContents]);
  const removeSheet = useCallback(() => {
    const entry = currentName();
    const pendingContents = currentContents();
    const removed = session.apply({ kind: "remove-sheet", sheet });
    if (
      removed &&
      pendingContents &&
      !pendingContents.stranded &&
      pendingContents.target.sheet === sheet
    ) {
      discardContents();
    }
    // A name typed for the sheet the user removed goes with it.
    if (removed && entry && !entry.stranded && entry.target.sheet === sheet) {
      discardName();
    }
  }, [
    session,
    sheet,
    currentName,
    discardName,
    currentContents,
    discardContents,
  ]);
  const save = useCallback(() => session.save(), [session]);

  return (
    <>
      <nav aria-label="Sheets" id="sheets">
        {view.sheets.map((name) => (
          <SheetTab
            current={name === sheet}
            key={name}
            name={name}
            onChoose={choose}
          />
        ))}
      </nav>
      <SheetControls
        editable={writable && !strandedName}
        name={typedName ?? sheet}
        onAdd={addSheet}
        onRemove={removeSheet}
        onRename={renameSheet}
        onType={typeSheetName}
        writable={writable}
      />
      {strandedName && (
        <StrandedText
          label={`Name not given to ${strandedName.target.sheet}`}
          onDiscard={discardName}
          text={strandedName.text}
        >
          The sheet {strandedName.target.sheet} was renamed or removed
          elsewhere, so the name you typed for it was not given. Copy it before
          discarding it.
        </StrandedText>
      )}
      {stranded && (
        <StrandedText
          label={`Not entered in ${stranded.target.sheet}!${stranded.target.cell}`}
          onDiscard={discardContents}
          text={stranded.text}
        >
          The sheet {stranded.target.sheet} was renamed or removed elsewhere, so
          what you typed for {stranded.target.cell} there was not entered. Copy
          it before discarding it.
        </StrandedText>
      )}
      <ContentsBar
        cell={cell}
        editable={writable && !stranded}
        initial={view.contents({ cell, sheet })}
        onDone={focusGrid}
        onDrop={dropContents}
        onEnter={enter}
        onType={type}
        request={request}
        typed={typed}
      />
      <div className="scroll" ref={grid}>
        <Grid
          onEdit={startEditing}
          onSelect={select}
          selected={selected}
          sheet={sheet}
          view={view}
          writable={writable}
        />
      </div>
      {writable && (
        <div>
          <button disabled={!dirty || saving} onClick={save} type="button">
            Save
          </button>
        </div>
      )}
    </>
  );
}

function SheetTab({
  current,
  name,
  onChoose,
}: {
  current: boolean;
  name: string;
  onChoose(name: string): void;
}) {
  const choose = useCallback(() => onChoose(name), [name, onChoose]);
  return (
    <button aria-pressed={current} onClick={choose} type="button">
      {name}
    </button>
  );
}

/**
 * Adds, renames and removes sheets. The name being typed belongs to the
 * SheetEditor, so a save underneath that renames the sheet cannot lose it.
 */
function SheetControls({
  editable,
  name,
  writable,
  onAdd,
  onRemove,
  onRename,
  onType,
}: {
  /** False while a stranded name waits to be discarded. */
  editable: boolean;
  name: string;
  writable: boolean;
  onAdd(): void;
  onRemove(): void;
  onRename(): void;
  onType(name: string): void;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onType(event.target.value),
    [onType]
  );
  const rename = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onRename();
    },
    [onRename]
  );
  return (
    <form className="bar" onSubmit={rename}>
      <button disabled={!writable} onClick={onAdd} type="button">
        Add sheet
      </button>
      <label htmlFor="sheet-name">Sheet name</label>
      <input
        disabled={!writable}
        id="sheet-name"
        maxLength={31}
        onChange={change}
        readOnly={!editable}
        value={name}
      />
      <button disabled={!editable} type="submit">
        Rename
      </button>
      <button disabled={!writable} onClick={onRemove} type="button">
        Remove sheet
      </button>
    </form>
  );
}

/** Pending text whose sheet is gone: shown so it can be copied, never applied. */
function StrandedText({
  children,
  label,
  text,
  onDiscard,
}: {
  children: ReactNode;
  label: string;
  text: string;
  onDiscard(): void;
}) {
  return (
    <section className="notice">
      <p>{children}</p>
      <input aria-label={label} readOnly value={text} />
      <button onClick={onDiscard} type="button">
        Discard it
      </button>
    </section>
  );
}

/**
 * The selected cell's contents, or the text being typed for it. Enter, or
 * focus leaving the bar, enters the text; Escape drops it. Text the
 * workbook refuses stays beside the refusal in the status line. The text
 * itself belongs to the SheetEditor, so it survives this field.
 */
function ContentsBar({
  cell,
  editable,
  initial,
  request,
  typed,
  onDone,
  onDrop,
  onEnter,
  onType,
}: {
  cell: string;
  editable: boolean;
  initial: string;
  request: EditRequest | null;
  /** Text typed for this cell and not entered yet. */
  typed: string | null;
  /** Editing ended by Enter or Escape: focus returns to the grid. */
  onDone(): void;
  onDrop(): void;
  /** Enters the typed text; false when it stays pending. */
  onEnter(): boolean;
  onType(text: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const shown = typed ?? initial;

  useEffect(() => {
    if (!request) {
      return;
    }
    if (request.initial !== undefined) {
      onType(request.initial);
    }
    input.current?.focus();
    // Only a new request starts editing, not a new cell to type into.
  }, [request]);

  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onType(event.target.value),
    [onType]
  );
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (onEnter()) {
        onDone();
      }
    },
    [onEnter, onDone]
  );
  // Focus moving between the field and the Enter button stays in the bar,
  // so a mouse press on Enter does not enter the text before it submits.
  const blur = useCallback(
    (event: FocusEvent<HTMLButtonElement | HTMLInputElement>) => {
      const next = event.relatedTarget;
      const bar = event.currentTarget.form;
      if (!(next instanceof Node && bar?.contains(next))) {
        onEnter();
      }
    },
    [onEnter]
  );
  const key = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onDrop();
      onDone();
    },
    [onDrop, onDone]
  );

  return (
    <form className="bar" onSubmit={submit}>
      <label htmlFor="contents" id="cell-name">
        {cell}
      </label>
      <input
        autoComplete="off"
        id="contents"
        onBlur={blur}
        onChange={change}
        onKeyDown={key}
        placeholder="A number, text, or a formula such as =SUM(A1:A3)"
        readOnly={!editable}
        ref={input}
        spellCheck={false}
        value={shown}
      />
      <button
        disabled={!editable || typed === null}
        onBlur={blur}
        type="submit"
      >
        Enter
      </button>
    </form>
  );
}
