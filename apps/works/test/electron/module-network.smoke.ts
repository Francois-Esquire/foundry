import assert from "node:assert/strict";
import { runElectronSmoke } from "../helpers/electron";
import { moduleReleasePackage } from "../helpers/module-release";
import { smokeWorks } from "../helpers/smoke-works";

const APPROVED = "https://example.com";
const UNAPPROVED = "https://example.net";
const APP_SCHEME = "module-app://";
const BLOCKED = /^blocked/u;

/** The fixture Program's `/probe` on `origin`, fetching `url` from inside the VM. */
function probeUrl(origin: string, url: string): URL {
  const probe = new URL("/probe", origin);
  probe.searchParams.set("url", url);
  return probe;
}

/**
 * A released Program under Microsandbox whose Manifest asks for
 * example.com: it reaches nothing before approval, exactly example.com once
 * the network Grant is approved, and nothing again after the revoke restarts
 * it.
 */
async function smoke(userData: string) {
  const works = await smokeWorks(userData);
  const { access, sessions } = works.rpc;
  const library = works.rpc.modules;
  const { encoded } = await moduleReleasePackage({
    capabilities: [],
    compatibility: { gateway: "1", runtime: "bun@1" },
    format: "foundry.module-manifest/1",
    network: {
      destinations: [{ host: "example.com" }],
      reason: "Network smoke",
    },
    persistence: { files: "installation" },
    program: { entry: "outputs/program.js" },
    views: { main: { path: "/", title: "Fixture" } },
  });
  const imported = await library.importPackage(encoded);
  const contentId = (await library.details(imported.id))?.releases[0]
    ?.contentId;
  assert.ok(contentId, "Imported release missing");
  const watch = sessions.watch(imported.id, contentId);
  let origin = "";
  /** Waits for the app's next Program (the first, or one a restart started). */
  async function next(): Promise<void> {
    const { value } = await watch.next();
    const endpoint = sessions.endpoint(
      value?.origin.replace(APP_SCHEME, "") ?? ""
    );
    assert.ok(endpoint, "The app has no endpoint");
    ({ origin } = endpoint);
  }
  /** What the open Program gets for `url`: `reached <status>` or `blocked …`. */
  async function probe(url: string): Promise<string> {
    const response = await fetch(probeUrl(origin, url), {
      signal: AbortSignal.timeout(20_000),
    });
    return response.text();
  }
  const results: string[] = [];
  try {
    await next();
    const before = await probe(APPROVED);
    assert.match(
      before,
      BLOCKED,
      `Network was reached before approval: ${before}`
    );
    results.push(`not approved, ${APPROVED}: ${before}`);

    // Approving restarts the open Program under the allowlist.
    const approved = await access.approve(imported.id, "network");
    assert.deepEqual(approved.scope.network, ["example.com"]);
    await next();
    const allowed = await probe(APPROVED);
    assert.equal(allowed, "reached 200", "The approved destination failed");
    results.push(`approved, ${APPROVED}: ${allowed}`);
    const other = await probe(UNAPPROVED);
    assert.match(other, BLOCKED, "An unapproved destination was reached");
    results.push(`approved, ${UNAPPROVED}: ${other}`);

    // Revoking is reported only once the allowlisted Program has stopped.
    const previous = origin;
    await access.revoke(imported.id, "network");
    const stale = await fetch(probeUrl(previous, APPROVED), {
      signal: AbortSignal.timeout(5000),
    }).then(
      (response) => response.text(),
      () => "unreachable"
    );
    results.push(`revoked, old Program: ${stale}`);
    assert.notEqual(stale, "reached 200", "The old Program still had network");
    await next();
    const revoked = await probe(APPROVED);
    assert.match(revoked, BLOCKED, "Revoked network was still reached");
    results.push(`revoked, ${APPROVED}: ${revoked}`);
    process.stdout.write(
      `Electron module network passed (Microsandbox):\n  ${results.join("\n  ")}\n`
    );
  } finally {
    await watch.return();
    await works.close();
  }
}

runElectronSmoke("module network", smoke);
