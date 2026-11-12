import type { Check } from "~/packaging/validation";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { OutcomeTag } from "./outcome-tag";

const checkKey = (check: Check<string>) => check.id;

/** The findings of a built font, check by check. */
export function CheckTable<Id extends string>({
  caption,
  checks,
  names,
}: {
  readonly caption: string;
  readonly checks: readonly Check<Id>[];
  readonly names: Readonly<Record<Id, string>>;
}) {
  const columns: readonly DataColumn<Check<Id>>[] = [
    {
      cell: (check) => names[check.id],
      header: "Check",
      id: "check",
      kind: "label",
    },
    {
      cell: (check) => <OutcomeTag outcome={check.outcome} />,
      header: "Result",
      id: "result",
      kind: "text",
    },
    {
      cell: (check) => (
        <>
          <p>{check.message}</p>
          {check.details.length > 0 ? (
            <ul className="ty-export-details">
              {check.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </>
      ),
      header: "What was found",
      id: "found",
      kind: "text",
    },
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rowKey={checkKey}
      rows={checks}
    />
  );
}
