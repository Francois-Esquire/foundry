import { type ChangeEvent, useCallback } from "react";
import type { FontFlavor } from "~/packaging/building";
import { readLicence } from "~/packaging/licence";
import type { ExportFinding } from "~/packaging/resolving";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Notice } from "~/ui/controls/notice";
import { Segmented } from "~/ui/controls/segmented";
import { TextField } from "~/ui/controls/text-field";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { FaceFacts } from "./face-facts";
import type { PlanDraft } from "./plan-draft";

interface NameSectionProps {
  readonly draft: PlanDraft;
  /** The chosen faces. */
  readonly faces: readonly FaceFacts[];
  /** Everything the resolved plan found, problems first. */
  readonly findings: readonly ExportFinding[];
  readonly onChange: (change: Partial<PlanDraft>) => void;
}

const FORMAT_OPTIONS: readonly { label: string; value: FontFlavor }[] = [
  { label: "TrueType (.ttf)", value: "ttf" },
  { label: "WOFF2 (.woff2)", value: "woff2" },
];

/** The findings that come from the source font's licence, or from keeping its name. */
const LICENCE_CODES: ReadonlySet<ExportFinding["code"]> = new Set([
  "reserved-font-name",
  "unknown-licence",
  "restricted-embedding",
  "no-subsetting",
  "family-name-kept",
  "reconstructed-lettering",
]);

const NAME_CODES: ReadonlySet<ExportFinding["code"]> = new Set([
  "reserved-font-name",
  "empty-family-name",
]);

const LICENCE_NAMES = {
  apache: "Apache License",
  ofl: "SIL Open Font License",
  unknown: "Not recognised",
} as const;

/** An empty font the app made has no licence to name, which is not "not recognised". */
const RECONSTRUCTED_LICENCE = "None. Made here for a reconstruction";

const LICENCE_COLUMNS: readonly DataColumn<FaceFacts>[] = [
  { cell: (row) => row.listLabel, header: "Face", id: "face", kind: "label" },
  {
    cell: ({ face, reconstructed }) =>
      reconstructed
        ? RECONSTRUCTED_LICENCE
        : LICENCE_NAMES[readLicence(face.description.licence).kind],
    header: "Licence the font names",
    id: "licence",
    kind: "text",
  },
  {
    cell: ({ face }) =>
      readLicence(face.description.licence).reservedNames.join(", ") || "None",
    header: "Reserved names",
    id: "reserved",
    kind: "text",
  },
];

const faceKey = (row: FaceFacts) => row.face.id;

/** The format, the family name, and what each source font's licence means for this export. */
export function NameSection({
  draft,
  faces,
  findings,
  onChange,
}: NameSectionProps) {
  const setFormat = useCallback(
    (format: FontFlavor) => onChange({ format }),
    [onChange]
  );
  const setFamilyName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ familyName: event.currentTarget.value }),
    [onChange]
  );
  const labels = new Map(
    faces.map((facts) => [facts.face.id, facts.listLabel])
  );
  const nameProblem = findings.find((finding) => NAME_CODES.has(finding.code));
  const licenceNotes = findings.filter(
    (finding) =>
      LICENCE_CODES.has(finding.code) && !NAME_CODES.has(finding.code)
  );
  return (
    <RuledSection
      heading="Format and name"
      lede="A derived font carries a family name of its own, so it never passes for the original. The source font's licence decides which names are allowed."
    >
      <div className="ty-export-stack">
        <Columns>
          <div className="ty-export-stack">
            <Segmented
              label="Format"
              onChange={setFormat}
              options={FORMAT_OPTIONS}
              value={draft.format}
            />
            <TextField
              autoComplete="off"
              error={nameProblem?.message}
              hint="Used for every derived font in the plan. Leave it empty to keep each face's own family name."
              label="Family name"
              onChange={setFamilyName}
              spellCheck={false}
              value={draft.familyName}
            />
          </div>
          <div className="ty-export-stack">
            <DataTable
              caption="The licence each chosen face names"
              columns={LICENCE_COLUMNS}
              rowKey={faceKey}
              rows={faces}
            />
            {licenceNotes.map((finding) => (
              <Notice key={`${finding.faceId}:${finding.code}`}>
                {finding.faceId ? `${labels.get(finding.faceId)}: ` : ""}
                {finding.message}
              </Notice>
            ))}
            {faces.length > 0 && licenceNotes.length === 0 && !nameProblem ? (
              <p className="ty-export-hint">
                Nothing in these licences stands in the way of this plan. This
                is a reading of what the fonts say about themselves, not legal
                advice.
              </p>
            ) : null}
          </div>
        </Columns>
      </div>
    </RuledSection>
  );
}
