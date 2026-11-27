# Sandbox

The sandbox context provides a portable, OS-agnostic execution surface and a
durable container orchestrator that drives isolated containers across local,
cloud, and virtual backends without leaking host or provider mechanics into the
core contract.

## Language

### Core

**Sandbox**:
The pure execution surface inside an isolated workspace: commands, files, a
working directory, and optional capability facets. A sandbox has no durable
identity, persistence, or lifecycle.
_Avoid_: VM, runtime, environment

**Container**:
One durable, independent isolated sandbox—whether backed locally, in the cloud,
or in memory. Identified by a stable id, configured by a spec, tracked through a
lifecycle, and usable as a sandbox while open.
_Avoid_: VM, instance, box, environment

**Containers**:
The pure, Web-standard outer orchestrator that creates containers, opens or
reconnects to existing ones, queries and lists them, drives lifecycle
transitions, persists durable records and events, and reconciles abandoned
resources.
_Avoid_: ContainerManager, SandboxSystem, ContainerRuntime

**Driver**:
The backend adapter at the seam between `Containers` and a concrete execution
substrate (such as Microsandbox, a cloud sandbox provider, or a virtual
in-memory runtime). Declares its capabilities up front and owns all provider-
and OS-specific mechanics.
_Avoid_: ContainerDriver, Runtime, Backend

**Facet**:
An optional capability surface on an open container (endpoints, processes,
services, shell, mounts, or POSIX storage) present only when the backing driver
supports it.
_Avoid_: plugin, extension

### Exposure & Lifecycle

**Network policy**:
The outbound traffic tier enforced on a container: `none` (offline), `allowlist`
(explicit hosts and ports), `internet` (public internet without host or LAN
access), or `open` (unrestricted).
_Avoid_: disableNetwork, firewall

**Endpoint**:
A driver-resolved address for reaching a port exposed by a container—either a
local loopback binding or a remote routed URL with optional access scope and
authorization headers.
_Avoid_: hostPort, portMapping

**Mount**:
Live external storage attached at a container path—such as a local host
directory or a driver-managed persistent volume—where writes are visible across
the boundary.
_Avoid_: copy, upload, volume (as a synonym for every mount)

**Transfer**:
Moving file bytes into or out of a container as a snapshot (`copyIn`, `copyOut`)
without live synchronization or mount guarantees.
_Avoid_: mount

**Secret binding**:
A declaration of outbound credential material scoped to allowed target hosts so
a driver or proxy can inject credentials without placing raw secrets inside the
container.
_Avoid_: env secret

**Lifetime**:
Server- or driver-enforceable retention rules on a container, including maximum
time-to-live (`ttlMs`), idle timeout (`idleTimeoutMs`), and release behavior.
_Avoid_: detached
