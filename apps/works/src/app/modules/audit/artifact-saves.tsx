import { useMemo } from "react";
import {
  type ArtifactSaveRow,
  type AuditRun,
  artifactSaves,
} from "~/shared/audit";
import { AuditRow, AuditTable, Time } from "./audit-table";
import { ModuleLink, type Names, RunLink } from "./scope";

const SAVE_KINDS = {
  file: "File",
  release: "Release",
  source: "Source",
} as const;
const ORIGINS = {
  build: "Build",
  disk: "Disk edit",
  module: "Module app",
  user: "You",
} as const;

function saveKind(save: ArtifactSaveRow): string {
  const tag = save.tag ? ` ${save.tag}` : "";
  const created = save.action === "created" ? " (created)" : "";
  return `${SAVE_KINDS[save.kind]}${tag}${created}`;
}

export function ArtifactSaves({
  names,
  runs,
}: {
  names: Names;
  runs: readonly AuditRun[];
}) {
  const rows = useMemo(() => artifactSaves(runs), [runs]);
  return (
    <AuditTable
      caption="Artifact saves"
      count={rows.length}
      empty="No committed saves in this scope and time range. Failed attempts are listed under Execution Runs."
      headers={[
        "Artifact",
        "Kind",
        "Origin",
        "Module",
        "Saved",
        "Recovery",
        "Run",
      ]}
    >
      {rows.map((row) => (
        <AuditRow key={row.id}>
          <td>
            {names.artifact(row.artifactId)}
            {row.path && (
              <span className="block font-mono text-muted-foreground text-xs">
                {row.path}
              </span>
            )}
          </td>
          <td>{saveKind(row)}</td>
          <td>{ORIGINS[row.origin]}</td>
          <td>
            <ModuleLink id={row.moduleId} names={names} />
          </td>
          <td>
            <Time value={row.updatedAt} />
          </td>
          <td>
            {row.recoveredFrom ? (
              <span>
                Recovered from <RunLink id={row.recoveredFrom} />
              </span>
            ) : (
              "Recorded"
            )}
          </td>
          <td>
            <RunLink id={row.runId} />
          </td>
        </AuditRow>
      ))}
    </AuditTable>
  );
}
