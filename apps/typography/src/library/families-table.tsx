import { useCallback, useMemo } from "react";
import type { Face, FaceId } from "~/typeface/face";
import { faceStyleName } from "~/typeface/face";
import { families, type TypefaceProject } from "~/typeface/project";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { useWorkspace } from "~/workspace/react";
import { variationLabel, weightLabel, widthLabel } from "./face-names";

interface FaceRow {
  readonly active: boolean;
  readonly face: Face;
  /** The family name on a family's first row, empty on the rows under it. */
  readonly familyHead: string;
}

/** Every face by family, the family named once at the head of its rows. */
const faceRows = (
  project: TypefaceProject,
  activeFaceId: FaceId | undefined
): FaceRow[] =>
  families(project).flatMap((family) =>
    family.faces.map((face, index) => ({
      active: face.id === activeFaceId,
      face,
      familyHead: index === 0 ? family.name : "",
    }))
  );

function FaceToggle({ active, face }: Pick<FaceRow, "active" | "face">) {
  const workspace = useWorkspace();
  const show = useCallback(() => {
    workspace.setActiveFace(face.id);
  }, [face.id, workspace]);
  return (
    <ToggleButton onPressedChange={show} pressed={active}>
      <span className="ty-visually-hidden">
        Show {face.description.familyName}{" "}
      </span>
      {faceStyleName(face)}
    </ToggleButton>
  );
}

const COLUMNS: readonly DataColumn<FaceRow>[] = [
  {
    cell: (row) => row.familyHead,
    header: "Family",
    id: "family",
    kind: "label",
  },
  {
    cell: (row) => <FaceToggle active={row.active} face={row.face} />,
    header: "Face",
    id: "face",
    kind: "text",
  },
  {
    cell: (row) => weightLabel(row.face.description.weightClass),
    header: "Weight",
    id: "weight",
    kind: "text",
  },
  {
    cell: (row) => widthLabel(row.face.description.widthClass),
    header: "Width",
    id: "width",
    kind: "text",
  },
  {
    cell: (row) => (row.face.description.italic ? "Italic" : "Upright"),
    header: "Slope",
    id: "slope",
    kind: "text",
  },
  {
    cell: (row) => variationLabel(row.face),
    header: "Variation",
    id: "variation",
    kind: "text",
  },
];

const rowKey = (row: FaceRow) => row.face.id;

interface FamiliesTableProps {
  readonly activeFaceId: FaceId | undefined;
  readonly project: TypefaceProject;
}

/** The project's fonts by family and face. Pressing a face shows it below. */
export function FamiliesTable({ activeFaceId, project }: FamiliesTableProps) {
  const rows = useMemo(
    () => faceRows(project, activeFaceId),
    [activeFaceId, project]
  );
  return (
    <DataTable
      caption="Fonts by family and face"
      columns={COLUMNS}
      rowKey={rowKey}
      rows={rows}
    />
  );
}
