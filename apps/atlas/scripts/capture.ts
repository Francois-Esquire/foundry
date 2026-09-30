/**
 * Manual capture tool: opens the viewer in a headless browser over the Chrome
 * DevTools Protocol, runs a few steps, saves screenshots, and reports console
 * errors. It is for checking the look by eye, not part of the test command.
 *
 *   bun scripts/capture.ts --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --url http://127.0.0.1:5199/ --tag overview zoom=6 wait=1500 shot=zoomed errors
 *
 * Steps: click=<button text or aria-label>, press=<label> (no screenshot),
 * zoom=<steps>, hover=<x>,<y>, tap=<x>,<y> (a mouse click on the page),
 * wait=<ms>, shot=<name>, eval=<expression>, clearlog, errors. Screenshots land in .cache/shots/<tag>-<name>.png.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: {
    args?: { description?: string; value?: unknown }[];
    exceptionDetails?: { exception?: { description?: string }; text?: string };
    type?: string;
  };
  result?: {
    data?: string;
    exceptionDetails?: { text?: string };
    result?: { value?: unknown };
  };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: "string" },
    height: { default: "800", type: "string" },
    out: {
      default: resolve(import.meta.dirname, "../.cache/shots"),
      type: "string",
    },
    tag: { default: "capture", type: "string" },
    url: { default: "http://127.0.0.1:5199/", type: "string" },
    webgpu: { default: false, type: "boolean" },
    width: { default: "1200", type: "string" },
  },
});
if (!values.browser) {
  throw new Error(
    "Pass --browser with the path to a Chrome or Chromium binary."
  );
}
const width = Number(values.width);
const height = Number(values.height);
const port = 9333 + Math.floor(Math.random() * 500);
const profile = resolve(values.out, `profile-${port}`);
const args = [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--window-size=${width},${height}`,
  "--no-first-run",
  `--user-data-dir=${profile}`,
  "--ignore-gpu-blocklist",
  ...(values.webgpu
    ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  "about:blank",
];
const sleep = (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });
const log = (line: string) => {
  process.stdout.write(`${line}\n`);
};

async function findPage(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = (await response.json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = targets.find((target) => target.type === "page");
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // The browser is still starting.
    }
  }
  throw new Error("The browser never exposed a page target.");
}

function connect(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, (message: CdpMessage) => void>();
  const logs: string[] = [];
  let nextId = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    const waiter =
      message.id === undefined ? undefined : pending.get(message.id);
    if (message.id !== undefined && waiter) {
      waiter(message);
      pending.delete(message.id);
      return;
    }
    const { method, params } = message;
    if (
      method === "Runtime.consoleAPICalled" &&
      (params?.type === "error" || params?.type === "warning")
    ) {
      const text = (params.args ?? [])
        .map((arg) => String(arg.value ?? arg.description ?? ""))
        .join(" ");
      logs.push(`${params.type}: ${text.slice(0, 600)}`);
    } else if (method === "Runtime.exceptionThrown") {
      const details = params?.exceptionDetails;
      logs.push(
        `exception: ${(details?.exception?.description ?? details?.text ?? "").slice(0, 600)}`
      );
    }
  };
  const send = (method: string, params: object = {}) =>
    new Promise<CdpMessage>((done) => {
      nextId += 1;
      pending.set(nextId, done);
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const response = await send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    return (
      response.result?.result?.value ?? response.result?.exceptionDetails?.text
    );
  };
  return {
    close: () => socket.close(),
    evaluate,
    logs,
    open: () =>
      new Promise<void>((done) => {
        socket.onopen = () => done();
      }),
    send,
  };
}

type Session = ReturnType<typeof connect>;

const buttonScript = (label: string) =>
  `(() => { const wanted = ${JSON.stringify(label)}; const button = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === wanted || b.getAttribute("aria-label") === wanted || b.title === wanted); if (!button) { return "missing"; } button.click(); return "ok"; })()`;

async function runStep(
  session: Session,
  step: string,
  shot: (name: string) => Promise<void>
) {
  const [action = "", ...rest] = step.split("=");
  const argument = rest.join("=");
  switch (action) {
    case "click":
      log(
        `click ${argument}: ${String(await session.evaluate(buttonScript(argument)))}`
      );
      await sleep(700);
      await shot(argument.replace(/\s+/g, "-").toLowerCase());
      break;
    case "press":
      log(
        `press ${argument}: ${String(await session.evaluate(buttonScript(argument)))}`
      );
      await sleep(700);
      break;
    case "zoom":
      for (let i = 0; i < Number(argument); i += 1) {
        await session.evaluate(buttonScript("Zoom in"));
      }
      await sleep(1500);
      break;
    case "hover": {
      const [x = 0, y = 0] = argument.split(",").map(Number);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      await sleep(120);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x + 2,
        y: y + 1,
      });
      break;
    }
    case "tap": {
      const [x = 0, y = 0] = argument.split(",").map(Number);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await session.send("Input.dispatchMouseEvent", {
          button: "left",
          clickCount: 1,
          type,
          x,
          y,
        });
      }
      await sleep(1500);
      break;
    }
    case "clearlog":
      session.logs.length = 0;
      break;
    case "errors":
      log(`errors: ${session.logs.length}`);
      for (const line of session.logs.slice(0, 12)) {
        log(`  ${line}`);
      }
      break;
    case "wait":
      await sleep(Number(argument));
      break;
    case "shot":
      await shot(argument);
      break;
    case "eval":
      log(`eval: ${String(await session.evaluate(argument))}`);
      break;
    default:
      throw new Error(`Unknown step: ${step}`);
  }
}

async function main() {
  await mkdir(values.out, { recursive: true });
  const browser = spawn(values.browser as string, args, { stdio: "ignore" });
  try {
    const session = connect(await findPage());
    await session.open();
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height,
      mobile: false,
      width,
    });
    await session.send("Page.navigate", { url: values.url });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(500);
      const ready = await session.evaluate(
        `(() => { const status = document.querySelector(".atlas-status")?.textContent || ""; return (!!document.querySelector("canvas") && !status) || status.includes("could not"); })()`
      );
      if (ready === true) {
        break;
      }
    }
    await sleep(2500);
    const shot = async (name: string) => {
      const response = await session.send("Page.captureScreenshot", {
        format: "png",
      });
      const file = resolve(values.out, `${values.tag}-${name}.png`);
      await writeFile(file, Buffer.from(response.result?.data ?? "", "base64"));
      log(`saved ${file}`);
    };
    await shot("initial");
    for (const step of positionals) {
      await runStep(session, step, shot);
    }
    log(
      `status: ${String(await session.evaluate(`document.querySelector(".atlas-status")?.textContent || ""`))}`
    );
    log(
      `webgpu: ${String(await session.evaluate(`typeof navigator.gpu !== "undefined"`))}`
    );
    session.close();
  } finally {
    browser.kill();
  }
}

await main();
