import { keptValue, stringifyValue } from "../session/serialize";

export class UnkeepableToolOutput extends Error {}

export function keepToolOutput(
  output: unknown,
  toolName: string,
  toolCallId: string
) {
  try {
    return keptValue(output);
  } catch (cause) {
    throw new UnkeepableToolOutput(
      `Tool "${toolName}" (call ${toolCallId}) returned a value with no JSON form, so the session cannot keep it: ${cause instanceof Error ? cause.message : stringifyValue(cause)}`,
      { cause }
    );
  }
}
