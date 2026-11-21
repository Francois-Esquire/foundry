# Works phase three: the Module library

Status: product direction captured; individual applications need their own
requirements and release plans. Keep everything super simple within each
feature, even as the library grows.

## Goal

Release full-featured micro-app Modules using the harness, Artifact API, and
collaboration conventions established in phases one and two. Agentic work is
built into these applications as a normal way to create and edit, alongside
direct human interaction.

Module source projects live in `modules/`, the core folder convention
established in phase one. Their output files are Artifacts, distinct from the
Module Artifacts that package the apps and the user's persisted workspaces.

## Initial library

| Module family | Direction |
| --- | --- |
| Docs/Markdown | First release: an Obsidian/Notion-style document experience whose primary output Artifacts are MD files. Select or port the existing editor implementation in this feature. |
| Docs | Grow the document authoring experience toward a full-featured Docs-like application; define its relationship to Markdown and any richer document representation explicitly. |
| Slides | Presentation authoring with integrated agentic creation and editing. |
| Sheets | Spreadsheet authoring with integrated agentic assistance. |
| Drawing/design | A Figma-like drawing and design application with agentic creation and editing. |
| Additional productivity apps | Extend the suite with similar applications as their own scoped Module releases. |

The Google suite, Figma, Obsidian, and Notion describe product categories and
experience references. Exact feature parity, external-service integration, and
file-format compatibility are not defined requirements yet. Decide whether
Docs/Markdown and richer Docs are one evolving Module or separate Modules before
planning their releases.

## Shared requirements for library Modules

- Use the Works core API to manage Artifacts and files, as well as to invoke
  approved agentic work and workflows. Do not add a private shared-file system
  for each app.
- Declare output types and editor entry points so files open through the common
  Artifact resolver. Markdown creates MD files as its main Artifact output.
- Use the common collaboration system so committed shared Artifact updates
  propagate automatically to authorized participants. Each Module still defines
  how to display updates, pending drafts, and conflicts for its data type.
- Support human/agent reconciliation through the common contract, including
  other participants' agents. Preserve attribution and edits rather than
  assuming that an agent is the only writer.
- Keep sensitive execution credentials at the authorized host. Apply the same
  capability and sharing policies whether an action begins in chat or a direct
  editor interaction.
- Participate in existing usage, execution, save, and review auditing.
- Use phase-two host resource monitoring and bounded autoscaling. Declare
  resource requirements and optionally report demand; do not implement a
  separate autoscaling controller in each Module.

Shared collaboration will rely heavily on remote workspaces. Private/local use
and the free, open-source local shell remain part of the product stance.

## Foundation required before collaborative releases

[Phase one](PHASE-ONE.md) supplies file Artifact access through the core API,
typed opening/editing, base revisions, local human/agent conflict handling,
Module loading, and controlled execution. [Phase two](PHASE-TWO.md) supplies
secure remote sharing, users and authorization, propagation/reconciliation,
organization catalogs, variants, and administrator-reviewed promotion.

The collaboration mechanism remains open: Git or another approach will be
evaluated against concrete Artifact types. Do not build the library around an
unselected protocol or claim collaboration is automatic before the shared
system demonstrates it. The first proof is a shared MD file edited by people
and agents, including concurrent edits and reconnects.

## Specialized applications

After the productivity foundation, plan more advanced Module families:

- Medical software, including an EHR, with an intuitive experience built around
  the healthcare data model. “Fire data” is provisionally interpreted as FHIR;
  confirm that meaning and the required version/integration scope in the medical
  planning feature.
- Legal applications.
- Finance applications.
- Other domain-specific applications as their requirements become clear.

These are goals for later planning, not claims of clinical, legal, financial,
or regulatory readiness. Each specialization needs its own users, workflows,
data semantics, integrations, and acceptance criteria before implementation.
No domain suite is part of the first Markdown Module release.

## Release approach and open decisions

Start with Docs/Markdown, then define a finite release scope for each additional
Module. “Full-featured” requires an explicit feature set and acceptance criteria
per application rather than a single milestone covering the whole suite.

For each release, define the Artifact representation, direct and agentic editing
flows, persistence, collaboration behavior, and distribution/versioning. Verify
local save/reopen, shared update propagation, concurrent human/agent edits,
permission changes, reconnect behavior, and audited execution in the modes the
Module supports.

Choose the suite's release order after Markdown, richer document formats,
spreadsheet/drawing representations, and specialization scope in their owning
plans. This document records phase three without selecting those architectures
or authorizing a combined implementation of the suite.
