import "./library.css";
import type { Face } from "~/typeface/face";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Columns } from "~/ui/layout/columns";
import {
  type Fact,
  licenceFacts,
  metricFacts,
  nameFacts,
} from "./face-details";
import { featureName } from "./layout-features";

const factKey = (fact: Fact) => fact.label;

const textColumns = (heading: string): readonly DataColumn<Fact>[] => [
  { cell: (fact) => fact.label, header: heading, id: "label", kind: "label" },
  { cell: (fact) => fact.value, header: "Value", id: "value", kind: "text" },
];

const NAME_COLUMNS = textColumns("Name");
const LICENCE_COLUMNS = textColumns("Licence notice");

const METRIC_COLUMNS: readonly DataColumn<Fact>[] = [
  { cell: (fact) => fact.label, header: "Metric", id: "label", kind: "label" },
  {
    cell: (fact) => fact.value,
    header: "Font units",
    id: "value",
    kind: "numeric",
  },
];

interface TagRow {
  readonly name: string;
  readonly tag: string;
}

const TAG_COLUMNS: readonly DataColumn<TagRow>[] = [
  { cell: (row) => row.tag, header: "Feature", id: "tag", kind: "label" },
  { cell: (row) => row.name, header: "Name", id: "name", kind: "text" },
];

const tagKey = (row: TagRow) => row.tag;

const featureRows = (tags: readonly string[]): TagRow[] =>
  tags.map((tag) => ({ name: featureName(tag) ?? "No registered name", tag }));

function FeatureTable({
  caption,
  tags,
}: {
  readonly caption: string;
  readonly tags: readonly string[];
}) {
  return tags.length > 0 ? (
    <DataTable
      caption={caption}
      columns={TAG_COLUMNS}
      rowKey={tagKey}
      rows={featureRows(tags)}
    />
  ) : (
    <p>None.</p>
  );
}

/** What the font file says about itself: names, metrics, layout and licence. */
export function FaceMetadata({ face }: { readonly face: Face }) {
  const { layout, licence, metrics } = face.description;
  return (
    <div className="ty-library-metadata">
      <Columns template="3fr 2fr">
        <DataTable
          caption="Names"
          columns={NAME_COLUMNS}
          rowKey={factKey}
          rows={nameFacts(face.description)}
        />
        <DataTable
          caption="Vertical metrics"
          columns={METRIC_COLUMNS}
          rowKey={factKey}
          rows={metricFacts(metrics)}
        />
      </Columns>
      <Columns>
        <div>
          <h3 className="ty-label">Substitution features</h3>
          <FeatureTable
            caption="Substitution features"
            tags={layout.substitution}
          />
        </div>
        <div>
          <h3 className="ty-label">Positioning features</h3>
          <FeatureTable
            caption="Positioning features"
            tags={layout.positioning}
          />
        </div>
        <div>
          <h3 className="ty-label">Layout scripts</h3>
          <p className="ty-label">
            {layout.scripts.length > 0
              ? layout.scripts.join(", ")
              : "The layout tables name no script."}
          </p>
          <p className="ty-library-note">
            OpenType script tags named in the layout tables. A tag here does not
            show that the script is fully covered or shapes correctly.
          </p>
        </div>
      </Columns>
      <DataTable
        caption="Licence notice read from the font"
        columns={LICENCE_COLUMNS}
        rowKey={factKey}
        rows={licenceFacts(licence)}
      />
    </div>
  );
}
