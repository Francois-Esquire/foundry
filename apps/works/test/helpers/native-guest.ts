import type { ContainerRuntime } from "@foundry/sandbox/container/types";
import { Sandbox } from "microsandbox";
import { moduleInstallationId } from "~/main/modules/runtime/installation";

const MIB = 1024 * 1024;
const MEM_TOTAL = /MemTotal:\s+(\d+) kB/;
/** The guest kernel keeps some memory for itself (3 to 4% measured). */
const KERNEL_SHARE = 0.08;

/** A Microsandbox VM's resources: as created, and as its guest sees them. */
export interface GuestResources {
  readonly configured: { readonly cpus: number; readonly memoryMib: number };
  readonly memTotalBytes: number;
  readonly nproc: number;
}

/** Reads a running VM's resources without taking over its lifecycle. */
export async function guestResources(name: string): Promise<GuestResources> {
  const sandbox = await (await Sandbox.get(name)).connect();
  const { resources } = await sandbox.config();
  if (
    !(
      resources &&
      typeof resources === "object" &&
      "cpus" in resources &&
      "memoryMib" in resources &&
      typeof resources.cpus === "number" &&
      typeof resources.memoryMib === "number"
    )
  ) {
    throw new Error(`VM ${name} reports no resources`);
  }
  const output = (
    await sandbox.shell("nproc; grep MemTotal /proc/meminfo")
  ).stdout();
  const memTotal = MEM_TOTAL.exec(output)?.[1];
  if (memTotal === undefined) {
    throw new Error(`VM ${name} reports no MemTotal: ${output}`);
  }
  return {
    configured: { cpus: resources.cpus, memoryMib: resources.memoryMib },
    memTotalBytes: Number(memTotal) * 1024,
    nproc: Number.parseInt(output, 10),
  };
}

/**
 * Asserts a VM got `cpus` and `memoryBytes` as the sandbox layer rounds
 * them (whole vCPUs and MiB, both up) and that its guest sees them.
 */
export function expectResources(
  label: string,
  actual: GuestResources,
  expected: { readonly cpus: number; readonly memoryBytes: number }
): string {
  const cpus = Math.ceil(expected.cpus);
  const memoryMib = Math.ceil(expected.memoryBytes / MIB);
  const configuredBytes = memoryMib * MIB;
  const problems = [
    actual.configured.cpus === cpus
      ? null
      : `created with ${actual.configured.cpus} vCPUs, expected ${cpus}`,
    actual.configured.memoryMib === memoryMib
      ? null
      : `created with ${actual.configured.memoryMib} MiB, expected ${memoryMib}`,
    actual.nproc === cpus ? null : `nproc ${actual.nproc}, expected ${cpus}`,
    actual.memTotalBytes <= configuredBytes &&
    actual.memTotalBytes >= configuredBytes * (1 - KERNEL_SHARE)
      ? null
      : `MemTotal ${actual.memTotalBytes} bytes, expected just under ${configuredBytes}`,
  ].filter((problem) => problem !== null);
  if (problems.length > 0) {
    throw new Error(`${label}: ${problems.join("; ")}`);
  }
  return `${label}: ${actual.configured.cpus} vCPU / ${actual.configured.memoryMib} MiB; guest nproc ${actual.nproc}, MemTotal ${Math.round(actual.memTotalBytes / MIB)} MiB`;
}

/** The running VM of a Module's released Program. */
export async function programVm(moduleId: string): Promise<string> {
  const page = await Sandbox.listWith((list) =>
    list.labels({ "com.foundry.installation": moduleInstallationId(moduleId) })
  );
  const running = page.sandboxes.filter(
    (handle) => handle.status === "running"
  );
  const [only] = running;
  if (!only || running.length > 1) {
    throw new Error(
      `Expected one running Program VM for ${moduleId}, found ${running.length}`
    );
  }
  return only.name;
}

/**
 * Microsandbox for Module sandboxes, telling `created` the name of every
 * VM it creates.
 */
export async function countedRuntime(
  created: string[]
): Promise<ContainerRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const runtime = createMicrosandboxRuntime();
  return {
    ...runtime,
    create(spec) {
      created.push(spec.name);
      return runtime.create(spec);
    },
  };
}
