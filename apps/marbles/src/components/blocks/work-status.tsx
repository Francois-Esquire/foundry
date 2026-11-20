import { Text } from "~/components/ui/text";

export function WorkStatus({
  busy,
  error,
  label,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly label: string;
}) {
  if (busy) {
    return <Text>{label}</Text>;
  }
  return error ? <Text>{error}</Text> : null;
}
