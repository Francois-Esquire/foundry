import { expect, it } from "vitest";
import { inTurn } from "~/lib/in-turn";

const fails = (message: string) => () => Promise.reject(new Error(message));
const passes = () => Promise.resolve();

it("runs the second whatever the first did, and reports every failure", async () => {
  const ran: string[] = [];
  const second = () => {
    ran.push("second");
  };
  await inTurn(passes, second, "both failed");
  await expect(inTurn(fails("dispose"), second, "both failed")).rejects.toThrow(
    "dispose"
  );
  await expect(inTurn(passes, fails("close"), "both failed")).rejects.toThrow(
    "close"
  );
  const both = await inTurn(
    fails("dispose"),
    fails("close"),
    "both failed"
  ).catch((error: unknown) => error);
  expect(both).toBeInstanceOf(AggregateError);
  expect(
    (both as AggregateError).errors.map((error: Error) => error.message)
  ).toEqual(["dispose", "close"]);
  expect(ran).toEqual(["second", "second"]);
});
