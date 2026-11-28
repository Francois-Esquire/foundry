import { defineCommand, noPositionals } from "~/cli/command";
import { describeTrigger } from "~/lib/schedule";
import { describeMonitor, type MonitorSpec } from "~/lib/schedule/monitor";

export const listCommand = defineCommand({
  group: "core",
  name: "list",
  needs: "triggers",
  parse: noPositionals("list"),
  async run(ctx) {
    const { automations, registry } = ctx.triggers;
    const created = new Map(
      (await automations.list()).map((record) => [record.id, record.source])
    );
    const watched = (key: string): MonitorSpec | undefined =>
      registry.monitors.get(key)?.source ?? created.get(key);
    const definitions = [...registry.entries()].map((entry) => ({
      kind: entry.kind,
      name: entry.name,
    }));
    const monitors: {
      readonly key: string;
      readonly source: string;
      readonly trigger: string;
    }[] = [];
    const schedules: {
      readonly input: unknown;
      readonly key: string;
      readonly trigger: string;
      readonly workflow: string;
    }[] = [];
    for (const schedule of await automations.schedules()) {
      const source =
        schedule.kind === "monitor" ? watched(schedule.key) : undefined;
      if (source) {
        monitors.push({
          key: schedule.key,
          source: describeMonitor(source),
          trigger: describeTrigger(schedule.trigger),
        });
      } else {
        schedules.push({
          input: schedule.input,
          key: schedule.key,
          trigger: describeTrigger(schedule.trigger),
          workflow: schedule.workflow,
        });
      }
    }
    const observers = ctx.opened.catalog.observerEntries().map((entry) => ({
      name: entry.name,
      source: entry.source,
      ...(entry.types === undefined ? {} : { types: entry.types }),
    }));
    ctx.output({ definitions, monitors, observers, schedules }, () =>
      [
        ...definitions.map((entry) => `[${entry.kind}] ${entry.name}`),
        ...monitors.map(
          (monitor) =>
            `[monitor] ${monitor.key} ${monitor.source} ${monitor.trigger}`
        ),
        ...schedules.map((schedule) => {
          const input =
            schedule.input === null ? "" : ` ${JSON.stringify(schedule.input)}`;
          return `[schedule] ${schedule.key} → ${schedule.workflow}${input} ${schedule.trigger}`;
        }),
        ...observers.map(
          ({ name, source, types }) =>
            `[observer] ${name} ← ${source}${types === undefined ? "" : ` ${types.join(", ")}`}`
        ),
      ].join("\n")
    );
  },
  summary: "steps, workflows, schedules and monitors with cadence, observers",
  usage: "list",
});
