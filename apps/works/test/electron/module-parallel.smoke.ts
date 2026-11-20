import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { moduleFolder } from "~/main/modules/local-library";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import type { Works } from "~/main/works";
import type { AuthoringTurnView } from "~/shared/authoring";
import type { ModuleBuildEvent, ModuleSourceRevision } from "~/shared/modules";
import { openAppWindow } from "../helpers/app-window";
import { type ScriptedStep, scriptedModels } from "../helpers/authoring-model";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { moduleReleasePackage } from "../helpers/module-release";
import {
  countedRuntime,
  expectResources,
  guestResources,
  programVm,
} from "../helpers/native-guest";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

const GIB = 1024 * 1024 * 1024;
const APP = "packages/app/src/App.tsx";
const PROBE = "native-probe.txt";
const SEEN = "native-seen.txt";
const NAME = "Parallel journey";
const SCRATCH_HEADING = "Agent scratch heading";
const USER_RESOURCES = { cpus: 1.5, memoryBytes: 1.5 * GIB + 512 * 1024 };
const MINIMUM_CPUS = 2;
const PROGRAM_MINIMUM = { cpus: 2, memoryBytes: GIB };
const TURN_DEADLINE_MS = 300_000;
const GUEST_USER = /^user=bun uid=1000$/m;
const BUILDS_DIRECTORY = /^drwx------ \d+ root root .* \/builds$/m;
const TWO_CPUS = /^nproc=2$/m;
const BUILDS_EXIT = /^(list|write|read)-builds-exit=(\d+)$/gm;

const PROBE_COMMAND = `{
  echo "user=$(id -un) uid=$(id -u)"
  echo "nproc=$(nproc)"
  grep MemTotal /proc/meminfo
  ls -ld /builds
  ls /builds >/dev/null 2>&1; echo "list-builds-exit=$?"
  touch /builds/agent-was-here 2>/dev/null; echo "write-builds-exit=$?"
  cat /builds/*/package.json >/dev/null 2>&1; echo "read-builds-exit=$?"
} > ${PROBE} 2>&1
for i in 1 2 3 4 5 6 7 8; do
  echo "// scratch $i" >> ${APP}
  for p in /proc/[0-9]*; do
    c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in *"bun install"*|*"bun run"*|*vite*|*tsc*) echo "$(stat -c %U "$p") $c" >> ${SEEN}.raw;; esac
  done
  sleep 1
done
sort -u ${SEEN}.raw > ${SEEN} 2>/dev/null; rm -f ${SEEN}.raw; touch ${SEEN}`;

interface Timed<T> {
  readonly at: number;
  readonly value: T;
}

async function build(
  works: Works,
  moduleId: string,
  tag: string,
  binding: ModuleSourceRevision,
  events: Timed<ModuleBuildEvent>[]
) {
  for await (const event of works.rpc.builds.watch(moduleId, tag, binding)) {
    events.push({ at: Date.now(), value: event });
    if (event.phase === "failed") {
      throw new Error(`Build ${tag} failed: ${event.message}`);
    }
    if (event.phase === "complete") {
      return event;
    }
  }
  throw new Error(`Build ${tag} ended without a result`);
}

async function settledTurn(
  works: Works,
  moduleId: string,
  turnId: string
): Promise<AuthoringTurnView> {
  let settled: AuthoringTurnView | undefined;
  await waitFor(
    async () => {
      const { turns } = await works.rpc.authoring.conversation(moduleId);
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (turn && !["queued", "running"].includes(turn.status)) {
        settled = turn;
      }
      return settled !== undefined;
    },
    "The chat turn did not finish",
    TURN_DEADLINE_MS
  );
  assert.ok(settled);
  return settled;
}

async function onlyTurnStatus(works: Works, moduleId: string) {
  const { turns } = await works.rpc.authoring.conversation(moduleId);
  assert.equal(turns.length, 1);
  return turns[0]?.status;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function smoke(userData: string) {
  const report: string[] = [];
  const note = (line: string) => {
    report.push(line);
    process.stdout.write(`  ${line}\n`);
  };
  const moduleRoot = path.join(userData, "foundry", "modules");
  const created: string[] = [];
  const buildEvents: Timed<ModuleBuildEvent>[] = [];
  let parallel:
    | {
        built: Promise<Extract<ModuleBuildEvent, { phase: "complete" }>>;
        installingAt: number;
        turnStatus: string | undefined;
      }
    | undefined;
  let startParallelBuild: () => Promise<void> = () =>
    Promise.reject(new Error("The build was started before the turn"));
  const script: ScriptedStep[] = [
    {
      tools: [
        {
          input: {
            file_path: APP,
            new_string: JSON.stringify(SCRATCH_HEADING),
            old_string: JSON.stringify(NAME),
          },
          name: "edit",
        },
      ],
    },
    {
      tools: [{ input: { command: PROBE_COMMAND }, name: "bash" }],
      wait: () => startParallelBuild(),
    },
    { text: "Edited the heading." },
    {
      tools: [
        {
          input: {
            command: `{ echo "nproc=$(nproc)"; grep MemTotal /proc/meminfo; } > ${PROBE}`,
          },
          name: "bash",
        },
      ],
    },
    { text: "Probed." },
  ];
  const { models } = scriptedModels(script);
  const works = await smokeWorks(userData, {
    containers: () => countedRuntime(created),
    models,
    routes: {
      route: () => ({ model: "scripted/coder", provider: "scripted" }),
    },
  });
  registerModuleProtocol(works.rpc.sessions);
  const { authoring, moduleSettings, modules } = works.rpc;
  try {
    const module = await modules.create(NAME);
    await moduleSettings.set(module.id, {
      "resources.cpus": USER_RESOURCES.cpus,
      "resources.memoryBytes": USER_RESOURCES.memoryBytes,
    });
    const saved = await modules.details(module.id);
    assert.ok(saved?.binding);
    const savedBinding = saved.binding;
    const savedSource = { ...saved.source };
    assert.ok(savedSource[APP]?.includes(JSON.stringify(NAME)));

    startParallelBuild = async () => {
      const built = build(works, module.id, "0.1.0", savedBinding, buildEvents);
      built.catch(() => undefined);
      await waitFor(
        () => buildEvents.some((event) => event.value.phase === "installing"),
        "The build did not start installing",
        300_000
      );
      const installing = buildEvents.find(
        (event) => event.value.phase === "installing"
      );
      assert.ok(installing);
      parallel = {
        built,
        installingAt: installing.at,
        turnStatus: await onlyTurnStatus(works, module.id),
      };
    };
    const sent = await authoring.send(module.id, {
      binding: savedBinding,
      prompt: "Change the heading.",
      source: savedSource,
    });
    const turn = await settledTurn(works, module.id, sent.id);
    const turnDoneAt = Date.now();
    assert.equal(turn.status, "complete", turn.error ?? "");
    assert.ok(parallel, "The turn ended without starting the build");
    const { built } = parallel;
    const buildDoneBeforeTurn = buildEvents.some(
      (event) => event.value.phase === "complete"
    );
    assert.equal(
      parallel.turnStatus,
      "running",
      "The build started installing while the turn was not running"
    );
    note(
      `overlap: build installing at +0 ms while the turn was ${parallel.turnStatus}; turn complete at +${turnDoneAt - parallel.installingAt} ms; build ${buildDoneBeforeTurn ? "had already finished" : "still running"} then`
    );

    const accepted = await authoring.accept(module.id, sent.id);
    const publishedBeforeAccept = buildEvents.some(
      (event) => event.value.phase === "complete"
    );
    if (accepted.status === "stale") {
      assert.ok(publishedBeforeAccept, accepted.message);
    }
    const { base, proposal } = await authoring.proposal(module.id, sent.id);
    const proposedApp = proposal[APP];
    assert.ok(proposedApp?.includes(JSON.stringify(SCRATCH_HEADING)));
    assert.ok(proposedApp?.includes("// scratch 8"));
    assert.equal(base[APP], savedSource[APP]);
    const probe = proposal[PROBE];
    const seen = proposal[SEEN];
    assert.ok(probe, "The probe file is missing from the proposal");
    assert.ok(seen !== undefined && seen !== null);
    note(
      `proposal: ${turn.proposal?.paths.length} paths (${Object.keys(proposal).sort().join(", ")}); accept ${accepted.status}${accepted.status === "stale" ? " (the build published first)" : ""}`
    );
    await authoring.settleProposal(module.id, sent.id, "dismissed");

    assert.match(probe, GUEST_USER);
    const exits = [...probe.matchAll(BUILDS_EXIT)];
    assert.deepEqual(
      exits.map(([, attempt]) => attempt),
      ["list", "write", "read"]
    );
    for (const [line, , code] of exits) {
      assert.notEqual(code, "0", `${line} succeeded: ${probe}`);
    }
    assert.match(probe, BUILDS_DIRECTORY);
    const rootBuildProcesses = seen
      .split("\n")
      .filter((line) => line.startsWith("root "));
    assert.ok(
      rootBuildProcesses.length > 0,
      `The agent saw no build process while it ran:\n${seen}`
    );
    note(
      `guest: agent ran as bun (uid 1000); ls/touch/cat /builds denied (${probe
        .split("\n")
        .filter((line) => line.includes("-builds-exit"))
        .join(
          ", "
        )}); it saw ${rootBuildProcesses.length} root build processes in the shared kernel, e.g. "${rootBuildProcesses[0]?.slice(0, 80)}"`
    );

    const complete = await built;
    const buildDoneAt = Date.now();
    note(
      `build: complete ${complete.release.tag} ${buildDoneAt - turnDoneAt} ms after the turn; phases ${buildEvents.map((event) => event.value.phase).join(" → ")}`
    );
    const released = await modules.details(module.id);
    assert.ok(released);
    const { "bun.lock": lock, ...releasedSource } = released.source;
    const { "bun.lock": savedLock, ...expectedSource } = savedSource;
    assert.deepEqual(releasedSource, expectedSource);
    assert.ok(lock && (savedLock === undefined || lock === savedLock));
    for (const [file, text] of Object.entries(released.source)) {
      assert.ok(
        !(text.includes(SCRATCH_HEADING) || text.includes("// scratch")),
        `Scratch edits reached the release source: ${file}`
      );
    }
    assert.deepEqual(created.length, 1, "Chat and build used separate VMs");
    note(
      `one sandbox: ${created.length} Module VM created (${created[0]}) for the turn and the build`
    );
    const [authoringVm] = created;
    assert.ok(authoringVm);
    note(
      expectResources(
        "authoring/build VM, user settings 1.5 CPUs / 1.5 GiB + 512 KiB",
        await guestResources(authoringVm),
        USER_RESOURCES
      )
    );
    assert.match(probe, TWO_CPUS);

    const app = await openAppWindow(
      works.rpc.sessions,
      module.id,
      complete.release.contentId
    );
    try {
      assert.equal(await app.heading(), NAME);
      const outputs = await Promise.all(
        (await filesUnder(moduleFolder(moduleRoot, module.id).artifact)).map(
          (file) => readFile(file, "utf8")
        )
      );
      assert.ok(outputs.some((text) => text.includes(NAME)));
      assert.ok(!outputs.some((text) => text.includes(SCRATCH_HEADING)));
      note(
        `release: source equals saved source plus bun.lock; ${outputs.length} artifact/ files show "${NAME}", none the scratch heading`
      );
      note(
        expectResources(
          "released Program VM, same user settings",
          await guestResources(await programVm(module.id)),
          USER_RESOURCES
        )
      );
    } finally {
      await app.close();
    }

    const { encoded } = await moduleReleasePackage({
      capabilities: [],
      compatibility: { gateway: "1", runtime: "bun@1" },
      format: "foundry.module-manifest/1",
      program: { entry: "outputs/program.js" },
      resources: PROGRAM_MINIMUM,
      views: { main: { path: "/", title: "Fixture" } },
    });
    const imported = await modules.importPackage(encoded);
    const importedRelease = (await modules.details(imported.id))?.releases[0];
    assert.ok(importedRelease);
    const fixture = await openAppWindow(
      works.rpc.sessions,
      imported.id,
      importedRelease.contentId
    );
    try {
      note(
        expectResources(
          "released Program VM, Manifest minimum 2 CPUs / 1 GiB",
          await guestResources(await programVm(imported.id)),
          PROGRAM_MINIMUM
        )
      );
    } finally {
      await fixture.close();
    }

    const minimum = await modules.create("Manifest minimum");
    const starter = await modules.details(minimum.id);
    assert.ok(starter?.binding);
    const manifestText = starter.source["foundry.module.json"];
    assert.ok(manifestText);
    const legacy: unknown = JSON.parse(manifestText);
    assert.ok(legacy && typeof legacy === "object");
    const strictSource = {
      ...starter.source,
      "foundry.module.json": JSON.stringify(
        {
          ...legacy,
          format: "foundry.module-manifest/1",
          persistence: { files: "installation" },
          resources: { cpus: MINIMUM_CPUS },
        },
        null,
        2
      ),
    };
    const strictBinding = await modules.saveSource(
      minimum.id,
      strictSource,
      starter.binding
    );
    const probed = await authoring.send(minimum.id, {
      binding: strictBinding,
      prompt: "Probe the sandbox.",
      source: strictSource,
    });
    const probedTurn = await settledTurn(works, minimum.id, probed.id);
    assert.equal(probedTurn.status, "complete", probedTurn.error ?? "");
    const minimumProbe = (await authoring.proposal(minimum.id, probed.id))
      .proposal[PROBE];
    assert.match(minimumProbe ?? "", TWO_CPUS);
    assert.equal(created.length, 2);
    const [, minimumVm] = created;
    assert.ok(minimumVm);
    note(
      expectResources(
        "authoring VM, Manifest minimum 2 CPUs (memory at its 2 GiB default)",
        await guestResources(minimumVm),
        { cpus: MINIMUM_CPUS, memoryBytes: 2 * GIB }
      )
    );

    process.stdout.write(
      `Electron parallel chat/build and resources passed (Microsandbox, Electron ${process.versions.electron}, ${report.length} checks)\n`
    );
  } finally {
    await works.close();
  }
}

runElectronSmoke("module parallel", smoke);
