import type { Project } from "ts-morph";
import type { SourceOwner } from "./boundary-model";
import { ownerResult } from "./boundary-model";

export interface OwnerTable {
  readonly errors: Map<string, unknown>;
  readonly owners: Map<string, string>;
}

export function emptyOwnerTable(): OwnerTable {
  return { errors: new Map(), owners: new Map() };
}

export function tableOwner(
  table: OwnerTable,
  filePath: string,
  ownerOf: SourceOwner
): void {
  if (table.owners.has(filePath) || table.errors.has(filePath)) {
    return;
  }
  const result = ownerResult(ownerOf, filePath);
  if ("ownerError" in result) {
    table.errors.set(filePath, result.ownerError);
  } else {
    table.owners.set(filePath, result.owner);
  }
}

export function tableProgramOwners(
  project: Project,
  table: OwnerTable,
  ownerOf: SourceOwner
): void {
  for (const file of project.getProgram().compilerObject.getSourceFiles()) {
    if (!file.fileName.includes("/node_modules/")) {
      tableOwner(table, file.fileName, ownerOf);
    }
  }
}
