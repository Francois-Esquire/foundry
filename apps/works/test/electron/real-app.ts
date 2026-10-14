import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectDevTools, until } from "./cdp";

/**
 * The real built app (`dist/main/index.js`, the production `index.ts`
 * wiring), launched with a temporary HOME and user data so it never touches
 * the user's library, driven over the DevTools protocol through phase one's
 * core file journey:
 *
 * startup → the audit tabs render → import the built Markdown fixture
 * package in the Catalog → approve its Grants in Access (chat, Access and
 * on/off are wired, unlike the per-feature smokes) → create a Markdown file
 * in Artifacts → it opens in the fixture's editor View (a released Program
 * under Microsandbox, in the Works iframe) → save there → the save shows in
 * Artifact Saves as the Module's → quit with SIGTERM, cleanly: exit 0, the
 * Program's run complete, the save's result on its run.
 *
 * `--use-mock-keychain` keeps the vault's safeStorage off the login
 * keychain (a temporary-HOME launch hung at startup without it).
 * Microsandbox stays where it is installed (`MSB_HOME`), since HOME moves.
 */

const FILE_NAME = "Smoke notes";
const EDITED =
  "# Smoke notes\n\nSaved from the fixture editor in the real app.\n";
const works = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(
  works,
  "modules/markdown-fixture/dist/markdown-fixture.module.json"
);
const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") {
  throw new Error("Electron's launcher did not return its executable path");
}
const home = await mkdtemp(path.join(tmpdir(), "works-real-app-"));
const userData = path.join(home, "user-data");
const child = spawn(
  electron,
  [
    path.join(works, "dist/main/index.js"),
    `--user-data-dir=${userData}`,
    // Any free port: Chromium names it in userData/DevToolsActivePort.
    "--remote-debugging-port=0",
    "--use-mock-keychain",
  ],
  {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: undefined,
      ELECTRON_RUN_AS_NODE: undefined,
      HOME: home,
      MSB_HOME: process.env.MSB_HOME || path.join(homedir(), ".microsandbox"),
    },
    stdio: ["ignore", "inherit", "pipe"],
  }
);
let stderr = "";
child.stderr?.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});
const exited = new Promise<{ code: number | null; signal: string | null }>(
  (resolve) => child.once("close", (code, signal) => resolve({ code, signal }))
);

/** The tab panel named by the tab labelled `name` (Radix links them by id). */
const panel = (name: string) =>
  `document.getElementById([...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent === ${JSON.stringify(name)})?.getAttribute("aria-controls") ?? "")`;
const panelText = (name: string) => `(${panel(name)}?.textContent ?? "")`;
const clickButton = (text: string) =>
  `(() => { const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)} && !candidate.disabled); button?.click(); return Boolean(button); })()`;
const typeInto = (selector: string, value: string) =>
  `(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;

interface RunRecord {
  name: string;
  observations: { kind: string; type?: string }[];
  status: string;
}

async function runRecords(): Promise<RunRecord[]> {
  const directory = path.join(userData, "engine", "state", "executions");
  return await Promise.all(
    (await readdir(directory)).map(
      async (file) =>
        JSON.parse(
          await readFile(path.join(directory, file), "utf8")
        ) as RunRecord
    )
  );
}

const results: string[] = [];
let quit = false;
let devtools: Awaited<ReturnType<typeof connectDevTools>> | undefined;
try {
  devtools = await connectDevTools(userData);
  const { evaluate, inApp, inPage, send } = devtools;
  await inPage(
    `!!document.querySelector('nav[aria-label="Main"]')`,
    "the shell"
  );
  await evaluate(`location.hash = "#/modules?tab=dashboard"`);
  await inPage(`${panelText("Dashboard")}.includes("Cost")`, "the Dashboard");
  for (const [tab, name] of [
    ["calls", "Calls"],
    ["workflows", "Workflow Runs"],
    ["saves", "Artifact Saves"],
  ]) {
    await evaluate(`location.hash = "#/modules?tab=${tab}"`);
    await inPage(
      `${panelText(name ?? "")}.includes("in this scope")`,
      `the ${tab} tab`
    );
  }
  results.push("startup: shell and audit tabs rendered from the run store");

  // Import the built fixture package through the Catalog's file input.
  await evaluate(`location.hash = "#/modules"`);
  await inPage(`!!document.getElementById("module-package")`, "the Catalog");
  const { root } = (await send("DOM.getDocument")) as {
    root: { nodeId: number };
  };
  const { nodeId } = (await send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#module-package",
  })) as { nodeId: number };
  await send("DOM.setFileInputFiles", { files: [fixture], nodeId });
  const moduleId = String(
    await inPage(
      `location.hash.startsWith("#/modules/") && decodeURIComponent(location.hash.slice("#/modules/".length))`,
      "the imported Module's page"
    )
  );
  results.push(`import: Markdown fixture package → Module ${moduleId}`);

  // Approve its requests in Access. Chat, Access and on/off are wired here.
  await inPage(
    `[...document.querySelectorAll("[role=tab]")].some((tab) => tab.textContent.startsWith("Access"))`,
    "the Module's tabs"
  );
  await evaluate(
    `[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.startsWith("Access")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))`
  );
  await inPage(
    `!!document.querySelector('ul[aria-label="Requests"]')`,
    "the Access requests"
  );
  for (let approved = 0; ; approved += 1) {
    const remaining = (await inPage(
      `(() => { const list = document.querySelector('ul[aria-label="Requests"]'); if (!list || list.querySelector("button[disabled]")) { return null; } return [...list.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label")?.startsWith("Approve")).length + 1; })()`,
      "the Access panel to settle"
    )) as number;
    if (remaining === 1) {
      results.push(`access: approved ${String(approved)} requests`);
      break;
    }
    if (approved > 20) {
      throw new Error("Approving never finished");
    }
    await evaluate(
      `document.querySelector('ul[aria-label="Requests"] button[aria-label^="Approve"]').click()`
    );
    await delay(300);
  }
  const page = String(await evaluate("document.body.textContent"));
  for (const missing of [
    "Module chat is unavailable",
    "Module on/off is unavailable",
  ]) {
    if (page.includes(missing)) {
      throw new Error(`The real app showed "${missing}"`);
    }
  }
  results.push("wiring: chat, Access and on/off available on the Module page");

  // A person creates a Markdown file in Artifacts; it opens in the fixture.
  await evaluate(`location.hash = "#/artifacts"`);
  await inPage(
    clickButton("New Markdown file"),
    "the New Markdown file button"
  );
  await inPage(
    `!!document.getElementById("markdown-file-name")`,
    "the name dialog"
  );
  await evaluate(typeInto("#markdown-file-name", FILE_NAME));
  await inPage(clickButton("Create file"), "the Create file button");
  await inPage(
    `location.hash.startsWith(${JSON.stringify(`#/m/${encodeURIComponent(moduleId)}`)}) && location.hash.includes("binding=")`,
    "the fixture editor route"
  );
  results.push("create: New Markdown file → opened in the fixture editor");

  // The released Program starts under Microsandbox and serves the View.
  await until(
    () => inApp(`document.body?.dataset.ready === "true"`),
    "the fixture editor View in the Works iframe",
    720
  );
  const opened = String(await inApp(`document.getElementById("text").value`));
  if (opened !== `# ${FILE_NAME}\n`) {
    throw new Error(`The editor opened ${JSON.stringify(opened)}`);
  }
  await inApp(typeInto("#text", EDITED));
  await inApp(`document.getElementById("save").click()`);
  await until(
    () =>
      inApp(
        `document.getElementById("status").textContent === "Saved" && document.body.dataset.dirty === "false"`
      ),
    "the fixture to save",
    120
  );
  results.push("edit: read through the binding and saved in the View");

  // The save is in Artifact Saves, attributed to the Module app.
  await evaluate(`location.hash = "#/modules?tab=saves"`);
  await inPage(
    `(() => { const rows = [...(${panel("Artifact Saves")}?.querySelectorAll("tbody tr") ?? [])].map((row) => row.textContent); return rows.some((row) => row.includes(${JSON.stringify(FILE_NAME)}) && row.includes("Module app")) && rows.some((row) => row.includes(${JSON.stringify(FILE_NAME)}) && row.includes("You")); })()`,
    "the save in Artifact Saves"
  );
  results.push(
    "audit: Artifact Saves lists the file's create (You) and save (Module app)"
  );

  // Quit as the OS asks: cleanup drains, then the app exits.
  quit = true;
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited, delay(90_000).then(() => null)]);
  if (!outcome) {
    throw new Error("The app did not quit within 90 s of SIGTERM");
  }
  if (outcome.code !== 0) {
    throw new Error(
      `The app quit with ${JSON.stringify(outcome)} rather than exit 0`
    );
  }
  if (stderr.includes("Works cleanup failed")) {
    throw new Error("Quit cleanup reported a failure");
  }
  const runs = await runRecords();
  const programs = runs.filter((run) => run.name === "works.module.program");
  if (!programs.length || programs.some((run) => run.status !== "complete")) {
    throw new Error(
      `Program runs after quit: ${JSON.stringify(programs.map((run) => run.status))}`
    );
  }
  const saved = runs.some(
    (run) =>
      run.name === "works.file.save" &&
      run.status === "complete" &&
      run.observations.some(
        (observation) =>
          observation.kind === "result" && observation.type === "save"
      )
  );
  if (!saved) {
    throw new Error("No completed file save run with its result was recorded");
  }
  results.push(
    `quit: exit 0; ${String(programs.length)} Program run(s) complete; the save's result recorded (${String(runs.length)} runs)`
  );
  process.stdout.write(`Real app journey passed:\n  ${results.join("\n  ")}\n`);
} catch (error) {
  process.stdout.write(
    `Real app journey reached:\n  ${results.join("\n  ")}\n`
  );
  const seen = await devtools
    ?.evaluate(
      `location.hash + "\\n" + document.body.innerText.slice(0, 2000) + "\\n" + [...document.querySelectorAll("iframe")].map((frame) => frame.src).join("\\n")`
    )
    .catch(() => "(page unavailable)");
  process.stdout.write(
    `Page:\n${String(seen)}\nFrames: ${JSON.stringify(devtools?.frames() ?? [])}\n`
  );
  throw error;
} finally {
  devtools?.close();
  if (!quit) {
    child.kill();
  }
  const settled = await Promise.race([exited, delay(30_000).then(() => null)]);
  if (!settled) {
    child.kill("SIGKILL");
    await exited;
  }
  await rm(home, { force: true, maxRetries: 5, recursive: true });
}
