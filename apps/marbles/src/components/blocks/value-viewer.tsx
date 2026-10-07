import { JSONView } from "~/components/ui/json";
import { Text } from "~/components/ui/text";
import type { JsonValue } from "~/components/ui/types";

export function ValueViewer({
  value,
  focused,
  empty,
}: {
  readonly value: JsonValue | undefined;
  readonly focused: boolean;
  readonly empty: string;
}) {
  if (value === undefined) {
    return <Text>{empty}</Text>;
  }
  if (value !== null && typeof value === "object") {
    return <JSONView data={value} focused={focused} />;
  }
  return (
    <Text>{typeof value === "string" ? value : JSON.stringify(value)}</Text>
  );
}
