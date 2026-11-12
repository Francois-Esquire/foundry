import { useCallback } from "react";
import type { SourceFont, TypefaceProject } from "~/typeface/project";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { formatSize } from "~/ui/content/output-format";
import { Button } from "~/ui/controls/button";
import { RuledSection } from "~/ui/layout/ruled-section";
import { saveBytes } from "~/workspace/files";
import { useWorkspace } from "~/workspace/react";

function DownloadOriginal({ source }: { readonly source: SourceFont }) {
  const workspace = useWorkspace();
  const download = useCallback(() => {
    const original = workspace.exportOriginal(source.id);
    if (original.ok) {
      saveBytes(original.value.fileName, original.value.bytes);
    }
  }, [source.id, workspace]);
  return (
    <Button onClick={download} symbol="download">
      Download original
      <span className="ty-visually-hidden"> {source.fileName}</span>
    </Button>
  );
}

const sourceKey = (source: SourceFont) => source.id;

/**
 * The source files exactly as imported. This is a different action from
 * building: nothing is built, renamed, subset or validated, and the file that
 * comes out is the file that went in.
 */
export function OriginalsSection({
  project,
}: {
  readonly project: TypefaceProject;
}) {
  const columns: readonly DataColumn<SourceFont>[] = [
    {
      cell: (source) => source.fileName,
      header: "File",
      id: "file",
      kind: "label",
    },
    {
      cell: (source) =>
        [
          ...new Set(
            project.faces
              .filter((face) => face.sourceId === source.id)
              .map((face) => face.description.familyName)
          ),
        ].join(", "),
      header: "Family",
      id: "family",
      kind: "text",
    },
    {
      cell: (source) => formatSize(source.bytes.byteLength),
      header: "Size",
      id: "size",
      kind: "numeric",
    },
    {
      cell: (source) => <DownloadOriginal source={source} />,
      header: "Download",
      id: "download",
      kind: "text",
    },
  ];
  return (
    <RuledSection
      heading="Original files"
      lede="The source fonts exactly as they were imported, byte for byte. Nothing is built or renamed, and none of the project's changes are in them."
    >
      <DataTable
        caption="The original source files"
        columns={columns}
        rowKey={sourceKey}
        rows={project.sources}
      />
    </RuledSection>
  );
}
