import { useEffect, useState } from "react";

/** The answer to one request: the key it was asked with, and what came back. */
export type Settled<Key, Value> =
  | { readonly key: Key; readonly value: Value }
  | { readonly error: unknown; readonly key: Key };

/**
 * Asks again whenever the key changes and keeps only the newest request's
 * answer: one that arrives after a newer request was made is dropped.
 * Undefined until a first answer arrives. The answer carries its key, so a
 * caller can tell the answer to an earlier key from the one it is waiting
 * for. `load` must be the same function from one render to the next.
 */
export const useSettled = <Key, Value>(
  key: Key,
  load: (key: Key) => Promise<Value>
): Settled<Key, Value> | undefined => {
  const [settled, setSettled] = useState<Settled<Key, Value>>();
  useEffect(() => {
    let newest = true;
    load(key).then(
      (value) => {
        if (newest) {
          setSettled({ key, value });
        }
      },
      (error: unknown) => {
        if (newest) {
          setSettled({ error, key });
        }
      }
    );
    return () => {
      newest = false;
    };
  }, [key, load]);
  return settled;
};
