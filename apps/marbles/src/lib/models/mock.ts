import type { Provider } from "@foundry/models";
import { Models } from "@foundry/models";
import type { TurnExecutorRef } from "~/lib/cli-harnesses";
import { isCliHarness } from "~/lib/cli-harnesses";
import { CLI_PROVIDER_FACTS } from "~/lib/harnesses";
import type { MockOptions, Reply } from "~/lib/models/echo";
import { replying } from "~/lib/models/echo";

function mockProvider(
  executors: readonly TurnExecutorRef[],
  reply: Reply,
  mockOptions: MockOptions
): Provider {
  const [executor] = executors as [TurnExecutorRef];
  const facts = isCliHarness(executor.provider)
    ? CLI_PROVIDER_FACTS[executor.provider]
    : undefined;
  const named = executors
    .map(({ model }) => model)
    .filter((model) => !facts?.models.some((row) => row.id === model))
    .map((model) => ({ id: model, kind: "text" as const, modelId: model }));
  return replying(
    {
      ...facts,
      models: [...(facts?.models ?? []), ...named],
    },
    executor,
    reply,
    mockOptions
  );
}

export function mockModels(
  executors: readonly TurnExecutorRef[],
  reply: Reply,
  options: MockOptions = {}
): Models {
  const byProvider = Map.groupBy(executors, ({ provider }) => provider);
  return new Models({
    providers: [...byProvider.values()].map((group) =>
      mockProvider(group, reply, options)
    ),
  });
}
