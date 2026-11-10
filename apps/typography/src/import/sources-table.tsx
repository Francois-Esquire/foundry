import { useCallback, useEffect, useMemo, useState } from "react";
import type { TypefaceProject } from "~/typeface/project";
import { formatBytes } from "~/ui/content/byte-size";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { useWorkspace } from "~/workspace/react";
import {
  describeWork,
  hasWork,
  type SourceRow,
  sourceRows,
} from "./imported-sources";

interface RemoveButtonProps {
  readonly onRemove: (row: SourceRow) => void;
  readonly row: SourceRow;
}

function RemoveButton({ onRemove, row }: RemoveButtonProps) {
  const remove = useCallback(() => onRemove(row), [onRemove, row]);
  return (
    <Button onClick={remove} symbol="remove">
      Remove<span className="ty-visually-hidden"> {row.fileName}</span>
    </Button>
  );
}

const rowKey = (row: SourceRow) => row.sourceId;

const columnsFor = (
  onRemove: (row: SourceRow) => void
): readonly DataColumn<SourceRow>[] => [
  { cell: (row) => row.fileName, header: "File", id: "file", kind: "text" },
  { cell: (row) => row.family, header: "Family", id: "family", kind: "text" },
  { cell: (row) => row.faces, header: "Faces", id: "faces", kind: "text" },
  {
    cell: (row) => formatBytes(row.byteLength),
    header: "Size",
    id: "size",
    kind: "numeric",
  },
  {
    cell: (row) => <RemoveButton onRemove={onRemove} row={row} />,
    header: "Remove",
    id: "remove",
    kind: "numeric",
  },
];

/**
 * The source fonts in the project. A font with no work on it is removed at
 * once. One whose faces carry changes or candidates asks first, in line, and
 * stops asking when that work is no longer there.
 */
export function SourcesTable({
  project,
}: {
  readonly project: TypefaceProject;
}) {
  const workspace = useWorkspace();
  const rows = useMemo(() => sourceRows(project), [project]);
  const [askingId, setAskingId] = useState<string>();
  // The prompt is about work on one font. Once that work is undone, or the
  // font is gone, there is nothing to ask about.
  const asking = rows.find(
    (row) => row.sourceId === askingId && hasWork(row.usage)
  );
  useEffect(() => {
    if (askingId !== undefined && !asking) {
      setAskingId(undefined);
    }
  }, [asking, askingId]);

  const remove = useCallback(
    (row: SourceRow) => {
      if (hasWork(row.usage)) {
        setAskingId(row.sourceId);
      } else {
        workspace.removeSource(row.sourceId);
      }
    },
    [workspace]
  );
  const columns = useMemo(() => columnsFor(remove), [remove]);
  const keep = useCallback(() => setAskingId(undefined), []);
  const removeWithWork = useCallback(() => {
    if (askingId !== undefined) {
      workspace.removeSource(askingId, { force: true });
    }
    setAskingId(undefined);
  }, [askingId, workspace]);

  return (
    <>
      <DataTable
        caption="Imported source fonts"
        columns={columns}
        rowKey={rowKey}
        rows={rows}
      />
      {asking ? (
        <Notice
          action={
            <>
              <Button onClick={removeWithWork} variant="solid">
                Remove font and work
              </Button>
              <Button onClick={keep}>Keep font</Button>
            </>
          }
        >
          {asking.fileName} has {describeWork(asking.usage)}. Removing the font
          removes that work too, and it cannot be undone.
        </Notice>
      ) : null}
    </>
  );
}
