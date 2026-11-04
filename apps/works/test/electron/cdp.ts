import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A small DevTools protocol client for driving the real app: one page, the
 * frames it attaches (a Module app's iframe may run out of process), and
 * script evaluation in either.
 */

interface Message {
  error?: { message: string };
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  sessionId?: string;
}

interface FrameTree {
  childFrames?: FrameTree[];
  frame: { id: string; url: string };
}

/** Where to evaluate: the page by default, a frame's context, or an attached session. */
export interface EvaluationTarget {
  readonly contextId?: number;
  readonly sessionId?: string;
}

/**
 * The port Chromium chose for `--remote-debugging-port=0`, read from the
 * `DevToolsActivePort` file it writes into the user data directory.
 */
async function activePort(userData: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(
      path.join(userData, "DevToolsActivePort"),
      "utf8"
    ).catch(() => "");
    const port = Number(text.split("\n")[0]);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
    await delay(300);
  }
  throw new Error("The app never opened its DevTools port");
}

async function pageSocket(port: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/json/list`,
        {
          signal: AbortSignal.timeout(2000),
        }
      );
      const targets = (await response.json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = targets.find((target) => target.type === "page");
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // Not listening yet.
    }
    await delay(300);
  }
  throw new Error("The app window never opened");
}

function moduleAppFrame(tree: FrameTree): string | null {
  if (tree.frame.url.startsWith("module-app:")) {
    return tree.frame.id;
  }
  for (const frame of tree.childFrames ?? []) {
    const found = moduleAppFrame(frame);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Retries `check` until it returns something truthy. */
export async function until(
  check: () => Promise<unknown>,
  what: string,
  attempts = 80
): Promise<unknown> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check().catch(() => undefined);
    if (value) {
      return value;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Connects to the app launched with `--user-data-dir=userData --remote-debugging-port=0`. */
export async function connectDevTools(userData: string) {
  const socket = new WebSocket(await pageSocket(await activePort(userData)));
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let requests = 0;
  const answers = new Map<number, (message: Message) => void>();
  /** Out-of-process frames attached as sessions, with their URLs. */
  const frameSessions = new Map<string, string>();
  /** Each in-page frame's default execution context, by frame id. */
  const frameContexts = new Map<number, string>();

  function send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    requests += 1;
    const id = requests;
    return new Promise((resolve, reject) => {
      answers.set(id, (message) => {
        answers.delete(id);
        if (message.error) {
          reject(new Error(`${method}: ${message.error.message}`));
        } else {
          resolve(message.result ?? {});
        }
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        })
      );
    });
  }

  function track(message: Message) {
    const params = message.params ?? {};
    if (message.method === "Target.attachedToTarget") {
      const info = params.targetInfo as { url: string };
      const sessionId = params.sessionId as string;
      frameSessions.set(sessionId, info.url);
      send("Runtime.enable", {}, sessionId).catch(() => undefined);
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      frameSessions.delete(params.sessionId as string);
      return;
    }
    // Contexts of in-page frames; attached sessions are asked directly.
    if (message.sessionId) {
      return;
    }
    if (message.method === "Runtime.executionContextCreated") {
      const context = params.context as {
        auxData?: { frameId?: string; isDefault?: boolean };
        id: number;
      };
      if (context.auxData?.isDefault && context.auxData.frameId) {
        frameContexts.set(context.id, context.auxData.frameId);
      }
    } else if (message.method === "Runtime.executionContextDestroyed") {
      frameContexts.delete(params.executionContextId as number);
    } else if (message.method === "Runtime.executionContextsCleared") {
      frameContexts.clear();
    }
  }

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id === undefined) {
      track(message);
    } else {
      answers.get(message.id)?.(message);
    }
  });

  async function evaluate(
    expression: string,
    target: EvaluationTarget = {}
  ): Promise<unknown> {
    const result = await send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        expression,
        returnByValue: true,
        ...(target.contextId === undefined
          ? {}
          : { contextId: target.contextId }),
      },
      target.sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(
        `Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`
      );
    }
    return (result.result as { value?: unknown } | undefined)?.value;
  }

  /** Evaluate in the Module app's frame, wherever Chromium put it. */
  async function inApp(expression: string): Promise<unknown> {
    // An out-of-process frame attaches before it navigates: ask where it is.
    for (const sessionId of frameSessions.keys()) {
      const href = await evaluate("location.href", { sessionId }).catch(
        () => ""
      );
      if (String(href).startsWith("module-app:")) {
        return await evaluate(expression, { sessionId });
      }
    }
    const { frameTree } = (await send("Page.getFrameTree")) as {
      frameTree: FrameTree;
    };
    const frameId = moduleAppFrame(frameTree);
    for (const [contextId, frame] of frameContexts) {
      if (frame === frameId) {
        return await evaluate(expression, { contextId });
      }
    }
    throw new Error("No Module app frame yet");
  }

  await send("Runtime.enable");
  await send("Target.setAutoAttach", {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: false,
  });
  return {
    close: () => socket.close(),
    evaluate,
    /** What frames are known, for a failure report. */
    frames: () => [...frameSessions.values(), ...frameContexts.values()],
    inApp,
    /** Retries `expression` in the page until it is truthy. */
    inPage: (expression: string, what: string, attempts?: number) =>
      until(() => evaluate(expression), what, attempts),
    send,
  };
}
