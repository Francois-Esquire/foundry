/**
 * Names the Works engine runs carry, shared by main (which launches them)
 * and the renderer (which shows them). Plain data: no engine import.
 */

/** Host task names: the Works actions an engine run carries. */
export const WORKS_TASKS = {
  access: "works.module.access",
  /** One Module authoring (chat) turn. */
  authoringTurn: "works.authoring.turn",
  build: "works.module.build",
  create: "works.module.create",
  /** A File Artifact created, with its first Content, in one transaction. */
  fileCreate: "works.file.create",
  /** Evidence re-recorded for a File Artifact save whose result write failed. */
  fileRecover: "works.file.recover",
  /** A frozen File Artifact opened for writing: its ready working successor. */
  fileRevise: "works.file.revise",
  /** A fenced in-place save of one File Artifact entry. */
  fileSave: "works.file.save",
  /** Disk edits of a File Artifact's directory written back to its records. */
  fileSync: "works.file.sync",
  import: "works.module.import",
  power: "works.module.power",
  program: "works.module.program",
  publish: "works.module.publish",
  save: "works.source.save",
  select: "works.module.select",
  settings: "works.module.settings",
  /** Evidence re-recorded for a source or release save whose result write failed. */
  sourceRecover: "works.source.recover",
  /** Disk edits of a Module's `source/` folder saved to its records. */
  sourceSync: "works.source.sync",
} as const;
