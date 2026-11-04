import assert from "node:assert/strict";
import { BrowserWindow, nativeTheme } from "electron";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { THEME_CAPABILITY } from "~/main/modules/theme-capability";
import { systemTheme } from "~/main/system/theme";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { themeReleasePackage } from "../helpers/module-release";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

const PRIVATE_PATHS = [
  "/_foundry/module-gateway",
  "/_foundry/health",
  "/_module/gateway",
];

/**
 * A released Program under Microsandbox, opened in a sandboxed window over
 * `module-app:`, follows main's theme through the Module SDK relay: the
 * initial snapshot, live explicit overrides, reconnect, disconnect, revoke,
 * re-approval and Program stop, with every private path unreachable.
 */
async function smoke(userData: string) {
  const works = await smokeWorks(userData);
  const { access, sessions } = works.rpc;
  const library = works.rpc.modules;
  const { encoded } = await themeReleasePackage();
  const imported = await library.importPackage(encoded);
  const contentId = (await library.details(imported.id))?.releases[0]
    ?.contentId;
  assert.ok(contentId, "Imported release missing");
  registerModuleProtocol(sessions);
  await access.approve(imported.id, THEME_CAPABILITY);
  const watch = sessions.watch(imported.id, contentId);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const evaluate = <T>(code: string): Promise<T> =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const shown = () =>
    evaluate<{ effective: string; mode: string }>(
      "({ effective: document.body.dataset.effective ?? '', mode: document.body.dataset.mode ?? '' })"
    );
  /** Waits until the View shows `mode`/`effective` ("" = cleared). */
  const showing = (mode: string, effective: string, message: string) =>
    waitFor(
      async () => {
        const current = await shown();
        return current.mode === mode && current.effective === effective;
      },
      message,
      20_000
    );
  const results: string[] = [];
  try {
    const { value } = await watch.next();
    assert.ok(value, "The app did not start");
    await window.loadURL(`${value.origin}/`);
    await waitFor(
      () => evaluate<boolean>('document.body?.dataset.ready === "true"'),
      "The theme View did not load",
      30_000
    );

    const initial = systemTheme.snapshot();
    assert.ok(initial);
    await showing(initial.mode, initial.effective, "No initial theme arrived");
    assert.equal(systemTheme.subscribers, 1);
    results.push(`initial: ${initial.mode}/${initial.effective}`);

    // Explicit overrides arrive live, and the View's CSS appearance agrees.
    for (const mode of ["dark", "light"] as const) {
      await systemTheme.set(mode);
      await showing(mode, mode, `The ${mode} override did not arrive`);
      assert.equal(
        await evaluate<boolean>(
          "matchMedia('(prefers-color-scheme: dark)').matches"
        ),
        mode === "dark"
      );
      results.push(`override ${mode}: ${mode}/${mode} (CSS agrees)`);
    }
    await systemTheme.set("auto");
    const desktop = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    await showing("auto", desktop, "Returning to auto did not arrive");
    results.push(`auto: auto/${desktop} (the desktop's appearance)`);

    // The desktop cannot be switched from here. Forcing the native source
    // behind main's back stands in for it: Electron emits `updated` with the
    // other appearance while main's mode is still auto.
    const other = desktop === "dark" ? "light" : "dark";
    nativeTheme.themeSource = other;
    await showing("auto", other, "A native appearance change did not arrive");
    nativeTheme.themeSource = "system";
    await showing("auto", desktop, "The desktop appearance did not return");
    results.push(
      `native appearance change in auto (simulated via themeSource): auto/${other}, then auto/${desktop}`
    );

    // Reconnect takes a fresh snapshot on a fresh subscription.
    const before = await evaluate<number>("window.themeEvents.length");
    await evaluate("window.startTheme()");
    await waitFor(
      async () =>
        (await evaluate<number>("window.themeEvents.length")) > before &&
        systemTheme.subscribers === 1,
      "Reconnecting did not refresh the theme",
      20_000
    );
    results.push("reconnect: fresh snapshot, one subscription");

    // Disconnecting releases the Gateway stream.
    await evaluate("window.stopTheme()");
    await waitFor(
      () => systemTheme.subscribers === 0,
      "Disconnecting the View left its theme subscription open"
    );
    results.push("disconnect: subscription released");

    const statuses = await evaluate<(number | string)[]>(
      `Promise.all([${PRIVATE_PATHS.map((route) => JSON.stringify(route)).join(",")}].map((path) => fetch(path).then((response) => response.status, () => "failed")))`
    );
    assert.deepEqual(statuses, [404, 404, 404]);
    // The proxy forwards a View's POST under /_module/; the Program, which
    // serves the theme only as a stream, refuses it.
    assert.equal(
      await evaluate<number>(
        "fetch('/_module/theme', { method: 'POST' }).then((response) => response.status)"
      ),
      502
    );
    results.push(
      `private paths: ${statuses.join(", ")}; POST theme: refused by the Program (502)`
    );

    // Revoking ends the relay and clears mode state in the View.
    await evaluate("window.startTheme()");
    await showing("auto", desktop, "The theme did not come back");
    await access.revoke(imported.id, THEME_CAPABILITY);
    await showing("", "", "Revoking did not clear the View's theme");
    await waitFor(
      () => systemTheme.subscribers === 0,
      "Revoking left the theme subscription open"
    );
    results.push("revoke: cleared, subscription released");

    // Approving again: the View's next retry gets an authorized snapshot.
    await access.approve(imported.id, THEME_CAPABILITY);
    await showing("auto", desktop, "Re-approval did not restore the theme");
    results.push("approve again: restored by the View's retry");

    // Stopping the Program ends the response; nothing stays subscribed.
    await watch.return();
    await showing("", "", "Stopping the Program left the View's theme");
    await waitFor(
      () => systemTheme.subscribers === 0,
      "Stopping the Program left the theme subscription open"
    );
    results.push("Program stop: cleared, subscription released");
    process.stdout.write(
      `Electron module theme passed (Microsandbox):\n  ${results.join("\n  ")}\n`
    );
  } finally {
    window.destroy();
    await watch.return();
    await works.close();
  }
}

runElectronSmoke("module theme", smoke);
