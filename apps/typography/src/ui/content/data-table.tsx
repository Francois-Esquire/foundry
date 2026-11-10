import "./data-table.css";
import type { ReactNode } from "react";

export interface DataColumn<Row> {
  readonly cell: (row: Row) => ReactNode;
  readonly header: string;
  readonly id: string;
  /**
   * "label" heads the row in capitals, "text" reads left, "numeric" aligns
   * right in tabular figures.
   */
  readonly kind: "label" | "numeric" | "text";
}

interface DataTableProps<Row> {
  /** Names the table for assistive technology. Not shown. */
  readonly caption: string;
  readonly columns: readonly DataColumn<Row>[];
  readonly rowKey: (row: Row) => string;
  readonly rows: readonly Row[];
}

/** A ruled table: ink under the head, hairlines under each row. */
export function DataTable<Row>({
  caption,
  columns,
  rowKey,
  rows,
}: DataTableProps<Row>) {
  return (
    <div className="ty-table-frame">
      <table className="ty-table">
        <caption className="ty-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                className="ty-label"
                data-kind={column.kind}
                key={column.id}
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) =>
                column.kind === "label" ? (
                  <th
                    className="ty-label"
                    data-kind="label"
                    key={column.id}
                    scope="row"
                  >
                    {column.cell(row)}
                  </th>
                ) : (
                  <td data-kind={column.kind} key={column.id}>
                    {column.cell(row)}
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
