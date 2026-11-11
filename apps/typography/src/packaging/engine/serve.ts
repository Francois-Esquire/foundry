/**
 * The worker's side of the engine protocol: starts the engine once, answers
 * calls one at a time in the order they arrive, and reports failures as data.
 */

import { reasonOf } from "~/lib/reason";
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

/**
 * Each call names a method of the port with that method's own arguments. The
 * compiler cannot follow that pairing through a union, hence the one cast.
 */
const run = (builder: FontBuilder, { args, kind }: EngineCall) =>
  (builder[kind] as (...given: typeof args) => Promise<EngineResult>)(...args);

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
      scope.postMessage({ kind: "failed", message: reasonOf(error) }, [])
  );

  const answer = async ({ call, id }: ToEngine) => {
    try {
      const { transfer, value } = handOver(await run(await engine, call));
      scope.postMessage({ id, kind: "result", value }, transfer);
    } catch (error) {
      scope.postMessage({ id, kind: "error", message: reasonOf(error) }, []);
    }
  };

  let last: Promise<void> = Promise.resolve();
  scope.addEventListener("message", ({ data }) => {
    last = last.then(() => answer(data));
  });
};
