# Marbles Daemon

The daemon context owns the Foundry state root for one machine, supervises
engine generations, and routes client traffic across them. It never loads user
authoring modules or executes workflow steps itself.

## Language

### Process and ownership

**Process identity**:
A process's operating-system PID paired with its OS start time. Used everywhere
to prove a PID still belongs to the same process before signalling it or
recovering its work.
_Avoid_: pid, handle, process info

**Claim**:
The daemon's single-instance hold on the Foundry state root via the process
lockfile and process descriptor. If the claim is lost, the daemon stops.
_Avoid_: lease (belongs to queue runs), mutex

**State root**:
The machine-local directory holding the daemon's socket, database, process
claim, and recovery records, resolved under Foundry home.
_Avoid_: data dir, cache dir

**State store**:
The daemon's record of registered workspaces, numbered generations and the
queued runs it sweeps. It is the state root's database once initialization has
made one, and is held in memory otherwise.
_Avoid_: repository, registry, db

### Generations

**Generation**:
One numbered engine subprocess spawned by the daemon to host registered
workspaces. Moves through loading, current, retiring, failed, or exited.
_Avoid_: worker, child, instance

**Candidate**:
A newly spawned generation that is loading workspaces before promotion. If it
fails to load while a current generation is healthy, it is refused without
disrupting the current generation.
_Avoid_: staging, standby, next

**Current generation**:
The single generation serving new work and normal workspace requests.
_Avoid_: active, primary, master

**Retirement**:
Telling the previous current generation to stop admitting new top-level work,
hand over its queued runs to a successor, and exit once its running work ends.
_Avoid_: shutdown, drain, decommission

**Hand-over**:
Transferring a queued run from a retiring generation to the current generation
so it starts on the new code.
_Avoid_: transfer, migration

**Adoption**:
Offering a queued run whose owning process is proved gone to the current
generation during recovery or sweep.
_Avoid_: steal, reclaim

### Lifecycle and wrapping

**Lifecycle**:
The daemon's durable state machine across process starts, runtime changes, and
binary recycles: acquiring the claim, running initialization, serving traffic,
retiring old work, and stopping cleanly.
_Avoid_: startup, boot loop, runtime loop

**Initialize**:
The lifecycle step the daemon runs whenever the hosted process changes (at
start, on upgrade, or on recycle) to prepare state before serving traffic. The
daemon drives when it runs without knowing the wrapped runtime's internal
storage or migration machinery.
_Avoid_: migrate, bootstrap, setup

**Wrapper**:
The hosted runtime plugged into the daemon. Clients plug into the daemon; the
daemon wraps and drives the runtime through lifecycle transitions rather than
coupling lifecycle state to a single live socket connection.
_Avoid_: plugin, adapter, backend

### Reload and self-update

**Fingerprint**:
A digest of the hosted installation and every hosted workspace's source tree
and out-of-tree read files, used to decide when to spawn a new generation.
_Avoid_: checksum, hash, snapshot

**Refused fingerprint**:
The fingerprint of a candidate that did not load, together with the outside
files the previous generation read. While the sources still match it, no new
candidate is started, so a broken edit does not reload in a loop.
_Avoid_: blocklist, failed hash

**Sweep**:
The periodic pass that records gone retiring generations as exited, hands
over queued runs the current generation owns but has not taken, and offers
adoption of queued runs whose owner is proved gone.
_Avoid_: reaper, garbage collection

**Recycle**:
The daemon replacing itself when its own executable bytes change on disk,
transitioning cleanly through initialization while letting retiring work finish.
_Avoid_: hot-reload, auto-update, respawn

**Spawn record**:
A small private JSON file, named for a generation's pid, written into the
directory `MARBLES_SPAWN_RECORD` names so a crashed owner's children can be
found and stopped. It holds the pid, its proved start, and that the child leads
its own process group.
_Avoid_: pidfile, lockfile
