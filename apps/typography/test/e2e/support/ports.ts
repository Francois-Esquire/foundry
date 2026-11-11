/**
 * The port of every file that starts the app or serves a page from it. They
 * are all here, so two files can never take the same one: a new file takes a
 * new line.
 */
export const PORTS = {
  addresses: 5345,
  browserEngine: 5314,
  captureFlows: 5341,
  export: 5333,
  family: 5337,
  generate: 5334,
  library: 5331,
  reconstruct: 5335,
  reviewFixes: 5340,
  scriptExtension: 5338,
  shell: 5330,
  studio: 5332,
  workflowCoverage: 5343,
  workflowExtend: 5336,
  workflowFamily: 5344,
  workflowReconstruct: 5342,
} as const;
