# Sheets

A Works Module for editing workbooks: named sheets of cells holding
numbers, text, booleans and formulas. Formulas can refer to other sheets
(`=Inputs!B2*2`, or `='My Data'!A1` when the name has spaces), and each edit
recalculates the cells that depend on it.

This is the first iteration. It edits, calculates, saves and reopens
workbooks, and does little else.

## Working on it

```sh
bun run build      # writes dist/sheets.module.json
bun run test       # one vitest run; the editor tests use happy-dom
bun run typecheck
```

Tests live in `src/test/`. The package test reads the built package, so
build before testing (Turbo does this for `bun run test` at the root).

Two Works tests cover Sheets inside composed Works.
`apps/works/test/main/sheets.test.ts` imports the built package, runs its
Program behind the real Module Gateway and Works' proxy, and drives the
View's routes. It also runs the editor's own `EditorSession` and
`ArtifactWorkbookHost` over that proxy: open, save, follow another
editor's save, and resolve a lost save. Another test saves the largest
workbook Sheets accepts through the real Gateway and gets it back whole in
a lost save's answer. No test has run the View in a browser or in the
Works app. The happy-dom tests check DOM behavior only.

## How it is put together

### Context map

| Context | Kind | Where | Relationship |
| --- | --- | --- | --- |
| Workbook | Core | `src/workbook/` | Owns contents, rules and the file format. |
| Formula calculation | Generic | `src/calculation/` | The Workbook defines `FormulaEngine`; HyperFormula is adapted to it. |
| Editing | Supporting | `src/editor/`, `src/draft.ts` | Uses the Workbook; owns the Draft, saving and conflicts. |
| Works Artifacts | Upstream | `src/editor/artifact-host.ts`, `src/program.ts` | Sheets conforms to Works' protocol behind one adapter. |

The Workbook is where Sheets has its own rules, so it gets the deepest
model. Calculation is a commodity: Sheets specifies what it needs and
buys the rest. Editing is necessary plumbing, kept apart from both so
neither the domain nor React knows about bindings, digests or chunks.

There are two anti-corruption layers. `calculation/hyperformula.ts`
translates HyperFormula's sheet ids, `{ sheet, col, row }` addresses,
`DetailedCellError` and printed formulas into Sheets' `CellReference`,
`CellValue` and `FormulaRewrite`. `editor/artifact-host.ts` translates
Works' bindings, base64 chunks, digests and event stream into
`OpenWorkbook`, `SaveAnswer` and `WatchEvent`. Nothing else imports
`hyperformula`, and nothing else knows the Artifact routes.

### How well the model holds

Scores out of 5, each against the code as it stands.

| Concern | Score | Evidence |
| --- | --- | --- |
| Workbook invariants | 5 | Every change goes through `#replace`; `calculation.test.ts` shows a failing engine leaves contents, file and values untouched. |
| Engine independence | 4 | Only `hyperformula.ts` imports the engine. Sheets reads values itself, and the specification suite checks a portable formula dialect against HyperFormula. No second real engine has passed it. |
| Editing races | 4 | A generation counter stops a late read from replacing newer work, and a save's answer keeps a newer version the watch reported; `session.test.ts` stages reload, save, create and conflict races. Not checked in a browser. |
| Host protocol | 3 | Reads are bounded and tested with a fake transport and through Works' proxy. The workbook size limit is measured as the Gateway carries it. The watch's reconnect is tested only against a fake. |
| Scale | 2 | Full rebuild and full file per edit; the grid shows A1:Z100 of A1:ZZ10000. |

### Who owns what

- `Workbook` (`workbook/workbook.ts`) owns the typed contents of every
  cell and is the only way to change them. Each change is atomic: it
  validates the next contents, writes their file and has the engine
  calculate them before replacing anything. A refused change throws a
  `WorkbookError` and leaves contents, file and values as they were.
- `FormulaEngine` (`calculation/engine.ts`) owns nothing. It derives values
  from a snapshot of contents and rewrites formulas for a sheet rename.
- `composition.ts` is the one place that picks the engine. `loadWorkbooks()`
  is async so an engine that has to load first (WebAssembly, a worker) is
  awaited there, before the editor starts.
- `EditorSession` (`editor/session.ts`) owns the open Workbook, its Draft
  against the saved entry, and every request to the host. React subscribes
  to its snapshots with `useSyncExternalStore` and calls its methods.
- `WorkbookHost` (`editor/host.ts`) is what the session needs from Works.
  `ArtifactWorkbookHost` implements it over the Program's routes.
- The React components (`editor/app.tsx`, `sheet-editor.tsx`, `grid.tsx`)
  own view state only: the chosen sheet, the selected cell and text being
  typed. `SheetEditor` holds typed text with the cell it was typed for,
  so it outlives the contents field.
- `view.tsx` builds one session for the page, renders the editor and
  starts the session. Leaving the page ends it.

### The formula engine specification

`FormulaEngine` is an abstract class whose doc comments are the
specification. It has two operations:

- `calculate(sheets)` returns a `Calculation` for that snapshot alone,
  with `value(reference)` and `close()`. Formulas that cannot be calculated
  get error values. It throws only when the engine itself fails.
- `renameSheetReferences(sheets, from, to)` returns the formulas whose
  text must change, and is pure. Formulas that do not refer to `from` are
  never returned, so they keep the spelling they were typed with.

Sheets decides what typed values are, not the engine. `readContents`
(`workbook/contents.ts`) reads `=` as a formula, a leading `'` as text,
plain numerals (`12`, `-3.5`, `.5`, `1e3`) as numbers, and `TRUE` or
`FALSE` in any case as booleans. Everything else is text: `10%`, `$10`,
`1,000`, ` 12` and dates. The HyperFormula adapter passes values in
already typed, because HyperFormula would read `10%` as 0.1.

The class comment then fixes a small portable formula dialect that every
engine must calculate alike:

- References `A1`, `A1:B3`, `$A$1`, `Name!A1` and `'My Data'!A1`, with
  cell and sheet names ignoring case.
- Operators by precedence, loosest first: comparisons between numbers,
  `&`, `+ -`, `* /`, a single `^`. Left to right within a level.
- An empty cell is 0 in arithmetic. Text that is not a numeral gives
  `#VALUE!`.
- SUM, AVERAGE, MIN, MAX, COUNT, ABS, ROUND (halves away from zero), IF,
  AND, OR, NOT, `TRUE()` and `FALSE()`, in any case. Over a range the
  first five count only numbers.
- `#DIV/0!`, `#REF!` for a missing sheet, `#VALUE!` and `#NAME?`, and a
  formula with an error operand has that error.

Everything else is engine-specific, and the comment lists what that
covers: chained `^` (`=2^3^2`), `-` before `^`, `%` in formulas,
comparing text, arithmetic on numeral text or booleans, bare `TRUE`
inside formulas, other functions, whole columns, error codes for syntax
errors and cycles, and array results. The error `message` a cell shows is
always the engine's own wording.

`src/test/helpers/engine-specification.ts` turns the portable rules into
a test suite, and `calculation.test.ts` runs it against HyperFormula. A
separate test there records HyperFormula's answers for the
engine-specific cases (`=2^3^2` is 64, `=-2^2` is 4, `=TRUE` is `#NAME?`,
arrays spill), so a change of engine shows which of them change.

To change engines, subclass `FormulaEngine` and `Calculation`, pass that
suite, and change `composition.ts`. Saved contents stay exactly as typed,
because calculating never changes them. Workbooks that use only the
portable dialect calculate the same. Workbooks that use engine-specific
features may show different values or errors afterwards. Sheets does not
detect which workbooks do. A test also runs the Workbook on a stub engine
to show it reaches the engine only through the specification; that proves
nothing about whether another real engine would pass.

### Editing guarantees

- An answer from the host never replaces work it did not see. If an edit,
  a save, a reload or a conflict choice happened while a read was in
  flight, the newer version is offered instead and local edits stay.
- A clean editor follows another writer's save. An editor with edits only
  shows that a newer version exists.
- One save at a time. Edits made during a save stay unsaved on top of the
  saved version. Saving with no edits sends nothing.
- A save's answer only proves the entry was unchanged when that save
  landed. If the watch reported another writer's save after it, the
  editor keeps that newer version: it loads it once there are no edits,
  and otherwise offers it. The watch reports saves in the order they
  happened, so the session never has to order digests itself.
- A session opens at most one workbook and follows it with one watch.
  Pressing New workbook twice creates one workbook; the button shows
  Creating… until the host answers.
- A save that loses to another writer offers both versions: keep mine
  (the next save replaces theirs) or use theirs.
- Text being typed in the contents field belongs to the cell it was typed
  for. It survives a save or reload underneath, including one that
  changes that cell. Enter, or focus leaving the contents bar, enters it.
  Escape drops it, and so does choosing another cell or sheet. If a newer
  save renames or removes its sheet, the text is not entered anywhere: it
  stays on screen, with the cell it was meant for, until the user
  discards it, and the contents field is read-only meanwhile. Once the
  session has shown a workbook without that sheet, a later sheet of the
  same name never receives the text. Workbook files name sheets but carry
  no identities, though, so a single save that replaces the sheet with a
  different one of the same name looks unchanged, and the text is entered
  in the new sheet. The same holds for a sheet name being typed.
- After `close()` the session publishes nothing and aborts its requests.

### Reading from Works

A read asks for the binding, then reads the entry in chunks. Every chunk
must carry the digest the binding reported, or the read starts over, three
attempts in all. An entry larger than 1,000,000 bytes is refused before
any chunk is read. A dropped watch reconnects after a second and resumes
after the last version it reported. However a watch response ends
(stream end, a removed workbook, an event that is not JSON, the editor
closing), its body is cancelled so the connection closes.

Saves and creates send the whole file as one JSON string inside one
Gateway frame of at most 1 MiB, so the file's size limit is measured that
way (see Workbook rules). A lost save is answered with the version saved
elsewhere. When another Sheets editor saved it, that answer fits too.
Another writer can save an entry up to Works' own file limit (16 MiB by
default), and then the Gateway cannot carry the answer: the save fails
with "the host could not send its answer", nothing is written, and the
edits stay unsaved. `apps/works/test/main/sheets.test.ts` checks this
against a 1.5 MB entry saved by another writer.

## Words

- **Contents**: what was typed in a cell, such as `12`, `'0042`, `TRUE` or
  `=SUM(A1:A3)`. This is what gets saved.
- **Value**: what the cell shows once calculated: a number, text, a
  boolean, empty, or an error such as `#DIV/0!`.
- **Draft**: the editor's workbook file against the last saved version it
  knows. It is dirty when the two differ or a conflict is unresolved.

A formula that cannot be calculated is not refused. It gets an error value
(`#ERROR!` for bad syntax, `#REF!` for a missing sheet, `#CYCLE!` for a
cycle) and keeps its contents, so it can be fixed later.

## Workbook rules

`Workbook` refuses a change that breaks one of these and stays as it was.
It throws a `WorkbookError` whose `code` names the rule.

- At least 1 sheet and at most 64.
- Sheet names are 1 to 31 characters with no surrounding spaces and none
  of `' [ ] : * ? / \`. They are unique ignoring case.
- Cells run from A1 to ZZ10000.
- A cell holds at most 32767 characters.
- The saved file, written as a JSON string, is at most 1,000,000 bytes:
  the UTF-8 bytes of `JSON.stringify(file)`. That is how a save or create
  carries it, so a backslash or quote in a cell counts 4 bytes and a
  control character up to 7. The rest of the 1 MiB Gateway frame (ids,
  binding, digest) needs under 1 KB of the remaining 48,576 bytes.
  `file.test.ts` checks the save, create and lost-save frames for the
  largest workbook Sheets accepts. A file Sheets could not save is
  refused when opened, as `too-large`.

Renaming a sheet rewrites the formulas that refer to it. Removing one
leaves those formulas in place showing `#REF!`, and they calculate again if
a sheet with that name comes back.

## File format

MIME type `application/vnd.foundry.workbook+json`, version 1:

```json
{
  "format": "foundry.workbook/1",
  "sheets": [
    { "cells": { "A1": "10", "B1": "=A1*2" }, "name": "Sheet1" }
  ]
}
```

Cells map A1 addresses to contents. Empty cells are left out. The file
never stores calculated values, so reopening calculates them again. Cells
are written in row order, so the same workbook always produces the same
bytes. The Draft relies on that to tell whether there are unsaved edits.

Opening refuses a file that is not JSON, has unknown fields, or breaks a
workbook rule (`invalid-file`). A file with a later `foundry.workbook/N`
is refused as `newer-format`.

## Licensing

The repository is MIT. This Module's own source is MIT too, but its built
View bundles [HyperFormula](https://handsontable.com/hyperformula/) 3.5.0,
which is dual-licensed by Handsontable: GPL-3.0-only, or a proprietary
license bought from them. No proprietary key exists for this project.
Sheets uses HyperFormula under the GPL by passing the `gpl-v3` license key
(`src/calculation/hyperformula.ts`).

So `dist/sheets.module.json` and its `outputs/view.js` combine MIT code
with GPL-3.0-only code, and anyone who distributes them must meet the
GPLv3's terms for that combination. The package declares
`MIT AND GPL-3.0-only` for that reason. Works itself does not depend on
Sheets at runtime: `apps/works` lists it only as a dev dependency for its
tests.

Before shipping Sheets outside this repository, someone has to decide
whether GPLv3 distribution is acceptable or buy a proprietary key. Without
a valid key HyperFormula calculates nothing (every function returns
`#LIC!`) and refuses edits. The engine specification exists partly so this
choice can change without touching the Workbook or the editor.

## Limits of this iteration

- The grid shows A1 to Z100. The workbook holds A1 to ZZ10000, so cells
  outside the grid can be saved and referred to but not seen or edited.
- Every change builds a new HyperFormula instance for the whole workbook
  and writes the whole file, and every save sends all of it. That makes
  atomic edits simple. On a development Mac, one edit to a workbook of
  30,000 cells (466 KB) took about 220 ms, and opening it about 420 ms.
- A sheet rename rewrites formulas that refer to it in HyperFormula's own
  spelling (`=sum(Inputs!a1)` becomes `=SUM('My Inputs'!A1)`). A formula
  HyperFormula cannot parse is not rewritten and shows `#REF!` after the
  rename.
- Formatting of any kind: number formats, dates, fonts, colours, column
  widths. Typed dates stay text, because a date value would show as a
  serial number.
- Inserting, deleting or moving rows and columns, copy and paste, fill,
  undo, find, sorting, named ranges, charts.
- XLSX or CSV import and export.
- Collaboration. Concurrent saves are fenced by digest and the losing save
  writes nothing.
- HyperFormula limits: no 3D references, structured references, or
  functions that depend on UI state such as hidden rows. `IF` reports a
  cycle if either branch would make one. HyperFormula does calculate
  arrays such as `=SEQUENCE(3)`: it spills them into empty cells below
  and to the right, or shows `#SPILL!` when those cells have contents.
  Spilled cells have no contents and nothing of a spill is saved. The
  specification classes arrays as engine-specific.
- `10%` and `$10` typed into a cell are text. Use `0.1` or `=10/100`.
