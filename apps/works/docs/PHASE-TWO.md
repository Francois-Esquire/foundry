# Works phase two: local-first collaborative workspaces

Status: product stance captured; architecture and implementation features remain
to be defined. Phase one establishes the local harness patterns first. Keep
everything super simple.

## Product stance

Works remains a free, open-source, local application shell, with a given set of
preexisting Modules available alongside it. The client and its working data
stay local. Remote workspaces add explicitly shared organization resources and
collaboration; they do not replace the local client or require every local
Artifact and private edit to be uploaded.

Support secure server deployment for these workspaces, including an on-premises
solution and an operator-hosted solution. The hosted offering is a potential
monetization path; its service implementation may live outside this repository.
Do not infer a final licensing or repository split from that possibility.

SQLite databases on durable storage are the intended data-store direction.
Define separately what stays in a client's local store and what an organization
chooses to retain in a remote shared store. The synchronization and durability
mechanisms, blob storage, and deployment topology are not decided yet.

## Organization catalog and Module variants

An organization selects a set of Modules for its employee catalog. Authorized
employees can discover, download, and use those Modules locally.

A user can vibe engineer an available Module to fit their own or their
organization's requirements. Those changes form a variant of the original
application. Other users can create their own variants, share them, and
collaborate through the remote Artifact and Module systems. Preserve the
relationship between the original Module and its variants, and the version each
variant was based on; copying an app must not erase its provenance.

Sharing a variant and making a version available organization-wide are separate
actions. A candidate version goes through administrator review before promotion
to the organization catalog. Smart reviews are part of this review direction;
their checks and automation are still to be defined. They support the review
process without implicitly granting publishing authority.

The exact fork/variant identity, concurrent-edit behavior, upstream update path,
and promotion mechanics need finite features of their own. Phase two does not
yet promise real-time co-editing or automatic merging.

## Shared file Artifacts and collaboration

Make collaboration a shared Artifact/Module system capability that library
Modules inherit through the Works API, rather than rebuilding synchronization in
each editor. Support file Artifacts as well as compound outputs. A committed
change to a shared Artifact must propagate to authorized connected participants
and reconcile with their local state and outstanding drafts.

People and their agents are concurrent writers. Preserve base revisions,
attribution, and recoverable conflicts when multiple participants edit the same
file. Define reconnect/offline reconciliation, duplicate-update handling, and
access revocation as part of the shared contract. A received remote update must
not silently replace unsaved local work.

The reconciliation mechanism is an open engineering item. Evaluate Git and other
models against text/code, Markdown, structured documents, spreadsheets, and
drawing data before selecting one or more type-appropriate approaches. Remote
storage or a version history alone does not establish a collaboration protocol.

Phase-three shared collaboration scenarios are expected to rely heavily on the
remote workspace. This applies to shared resources and coordination; it does
not change the local-first client stance or mandate remote storage for private
working data. The precise local/remote execution split remains to be designed.

## Users, roles, and secure communication

Introduce users and organization membership so the system knows who can access,
share, collaborate on, review, and promote resources. Define how administrators
are appointed and which versions they may approve. The server enforces RBAC;
client UI state and a Module's request cannot confer permission.

Secure both communication and access to hosted Modules, Artifacts, and workspace
data. Specify authenticated encrypted connections, authorization scope, and
revocation behavior as part of the connection contract. On-premises deployment
must follow the same contract rather than relying on network location as trust.

Expose only an authorized user-context slice to Modules that need it, using the
phase-one shared-state convention. Extend application/Module sharing policy
without exposing whole session objects or provider credentials. Sensitive calls
resolve credentials at their authorized execution host.

## Auditing and execution

Extend the phase-one Modules activity views with trustworthy user, organization,
and execution-host attribution. Preserve correlation between calls, workflow
runs, execution runs, and committed Artifact saves across connections.

Record collaboration and review/promotion activity so an organization can inspect
which version was submitted, reviewed, and made available, and by whom. Decide
what runs locally or remotely, where durable audit records live, and what the
client shows while disconnected. Remote collaboration alone does not imply all
Module execution moves to a server.

## Bounded Module resource autoscaling

Phase two owns host-controlled resource monitoring, bounded autoscaling and safe
standby. This is workspace/runtime infrastructure for local and remote execution;
phase-three Modules consume it rather than implement their own controllers.
Phase two delivers resource bounds, utilization/pressure measurement and the
automatic scaling controller together. Phase one uses explicit allocations; it
does not add autoscaling-specific bounds or instrumentation. No universal RAM allocation is approved by this
phase assignment; select defaults from measured workloads.

Each Module has minimum and maximum CPU/memory settings, capped by host capacity.
The host measures utilization and memory-pressure signals and enforces allocations.
Modules may contribute demand signals such as backlog or request latency, but
cannot change their own limits or authorize extra resources. Memory usage alone
is not proof of pressure. Distinguish idle, interactive, agent and build workloads
so temporary build demand does not become every app's permanent allocation.

Scale within bounds after sustained demand, with cooldowns and hysteresis to
avoid repeated resizing. Coordinate Modules against machine-wide capacity;
report constrained demand and leave requests queued when capacity is unavailable.
An idle Module that is on stays available, including when other Modules depend
on it. Do not evict or suspend it merely to free capacity.

Standby means reducing resource consumption while preserving that availability
contract. CPU reductions may slow responses; expose resulting latency and ensure
service targets still hold. Lowering a memory limit must not kill a process whose
working set exceeds it. Verify runtime support for live CPU/memory changes and
what resources a suspension actually releases before choosing a mechanism.
Suspension or restart requires proven wake-up/request buffering, dependency
handling and recovery; it is not an idle timeout. Automatic suspension is not
accepted until dependent Modules can use the service without interruption.

Break implementation into measurement, safe CPU adjustment, memory-safe resizing,
and dependency-aware standby features. Verify bounds and aggregate capacity,
sustained-load response, cooldown behavior, constrained demand, idle service
availability, dependent requests and crash recovery. Unsupported live resizing
must be reported honestly rather than silently restart an available Module.

Open implementation decisions: sampling/pressure signals, scaling thresholds and
cooldowns, resource defaults/ceilings, runtime resizing support, and whether a
safe standby mechanism can satisfy the availability contract. The phase-two
placement and host-owned bounded controller are decided.

## Decisions for the next discussion

- Define the first on-premises workspace deployment and hosted equivalent,
  including organization ownership and administrator bootstrap.
- Define local/private versus shared/remote data boundaries and explicit sharing
  actions, then choose synchronization and conflict recovery behavior.
- Prove propagation and human/agent reconciliation on a shared MD file before
  requiring each phase-three editor to use the common collaboration contract.
- Define Module variant identity, lineage, collaboration scope, and how an
  organization selects an approved version for its catalog.
- Define the administrator review/promotion flow and the first smart-review
  checks, including handling changes after a version has been reviewed.
- Define the smallest role/action matrix, user-context fields, and connection
  invalidation on identity changes or revoked access.
- Define SQLite ownership, durable storage, backups, and Artifact blob retention
  for each deployment mode.
- Define how the preexisting Module set is distributed; availability does not
  require every Module to be installed in every shell.

Break these into small features with explicit acceptance boundaries before
implementation. [Phase three](PHASE-THREE.md) releases the library Modules;
Docs/Markdown is its first Module using these conventions.
