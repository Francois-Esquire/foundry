/**
 * The worker's side of the engine protocol: starts the engine once, answers
 * calls one at a time in the order they arrive, and reports failures as data.
 */
import { unreachable } from "~/typeface/changes";
import type { FontBuilder } from "../building";
import type {
  EngineCall,
  EngineResult,
  FromEngine,
  ToEngine,
} from "./protocol";

/** What the server needs from a worker scope. A MessagePort fits too. */
export interface EngineScope {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: ToEngine }) => void
  ): void;
  postMessage(message: FromEngine, transfer: Transferable[]): void;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const run = (builder: FontBuilder, call: EngineCall): Promise<EngineResult> => {
  switch (call.kind) {
    case "blankFont":
      return builder.blankFont(call.request);
    case "build":
      return builder.build(call.request);
    case "buildVariable":
      return builder.buildVariable(call.request);
    case "describeLayout":
      return builder.describeLayout(call.font, call.faceIndex);
    case "validate":
      return builder.validate(call.font);
    default:
      return unreachable(call);
  }
};

/**
 * Built bytes are handed over, not copied. That is safe only for a view that
 * owns its whole buffer, which is what the engine host returns; anything else
 * is copied first so the transfer cannot take memory someone else still reads.
 */
const handOver = (value: EngineResult) => {
  if (!("bytes" in value)) {
    return { transfer: [], value };
  }
  const { bytes } = value;
  const owned =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
  return {
    transfer: [owned.buffer as ArrayBuffer],
    value: { ...value, bytes: owned },
  };
};

export const serveEngine = (
  scope: EngineScope,
  start: () => Promise<FontBuilder>
): void => {
  const engine = start();
  engine.then(
    () => scope.postMessage({ kind: "ready" }, []),
    (error: unknown) =>
      scope.postMessage({ kind: "failed", message: messageOf(error) }, [])
  );

  const answer = async ({ call, id }: ToEngine) => {
    try {
      const { transfer, value } = handOver(await run(await engine, call));
      scope.postMessage({ id, kind: "result", value }, transfer);
    } catch (error) {
      scope.postMessage({ id, kind: "error", message: messageOf(error) }, []);
    }
  };

  let last: Promise<void> = Promise.resolve();
  scope.addEventListener("message", ({ data }) => {
    last = last.then(() => answer(data));
  });
};
