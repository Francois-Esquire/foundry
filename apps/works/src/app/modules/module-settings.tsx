import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import {
  type ModuleSettingsView,
  refusedSettings,
} from "~/shared/module-settings";

type Problems = ModuleSettingsView["problems"];
type Description = ModuleSettingsView["keys"][number];

const KIB = 1024;
const MINUTE_MS = 60_000;

/** A value in its unit, readable: bytes in KiB/MiB/GiB, milliseconds in minutes. */
function settingValue(value: number | string, unit: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (unit === "bytes") {
    for (const [size, label] of [
      [KIB ** 3, "GiB"],
      [KIB ** 2, "MiB"],
      [KIB, "KiB"],
    ] as const) {
      if (value >= size && value % (size / KIB) === 0) {
        return `${Number((value / size).toFixed(2))} ${label}`;
      }
    }
    return `${value} bytes`;
  }
  if (unit === "ms" && value % 1000 === 0) {
    return value % MINUTE_MS === 0
      ? `${value / MINUTE_MS} min`
      : `${value / 1000} s`;
  }
  return `${value.toLocaleString("en-US")} ${unit}`;
}

function draftOf(view: ModuleSettingsView) {
  return Object.fromEntries(
    Object.entries(view.user).map(([key, value]) => [key, String(value)])
  );
}

function SettingRow({
  description,
  draft,
  effective,
  problem,
  change,
}: {
  description: Description;
  draft: string;
  effective: number | string | undefined;
  problem: string | undefined;
  change: (key: string, value: string) => void;
}) {
  const { key, programDefault, unit } = description;
  const id = `setting-${key}`;
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => change(key, event.target.value),
    [change, key]
  );
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_8rem] items-start gap-x-3 gap-y-1 py-2">
      <label className="font-mono text-xs" htmlFor={id}>
        {key}
      </label>
      <Input
        aria-describedby={`${id}-help`}
        aria-invalid={problem ? true : undefined}
        className="h-7 text-xs"
        id={id}
        inputMode="decimal"
        onChange={onChange}
        placeholder={String(description.default)}
        value={draft}
      />
      <p className="col-span-2 text-muted-foreground text-xs" id={`${id}-help`}>
        {effective === undefined
          ? ""
          : `Effective ${settingValue(effective, unit)} · `}
        Default {settingValue(description.default, unit)}
        {programDefault === undefined
          ? ""
          : ` (released app ${settingValue(programDefault, unit)})`}{" "}
        · Ceiling {settingValue(description.ceiling, unit)}
        {problem ? (
          <span className="block text-destructive">{problem}</span>
        ) : null}
      </p>
    </li>
  );
}

/**
 * Per-Module limits and preferences, within this host's ceilings. Saving
 * replaces the user's values; an empty field returns to the default. These
 * never approve access: that is Access.
 */
export function ModuleSettingsPanel({ moduleId }: { moduleId: string }) {
  const view = useQuery(
    worksApi().moduleSettings.get.queryOptions({ input: { id: moduleId } })
  );
  const retry = useCallback(() => {
    view.refetch().catch(() => undefined);
  }, [view.refetch]);
  return (
    <section aria-labelledby="module-settings-heading" className="min-w-0">
      <h2 className="font-medium text-sm" id="module-settings-heading">
        Module settings
      </h2>
      <p className="mt-1 text-muted-foreground text-xs">
        Limits and preferences for this Module, within this computer's ceilings.
        Leave a field empty to use the default. Settings never approve access;
        use Access for that. Changes apply the next time the Module's sandbox or
        app starts.
      </p>
      <p className="mt-1 text-muted-foreground text-xs">
        resources.memoryBytes and resources.cpus size both the Module's
        authoring and build sandbox and its released app, each from its own
        default. A Manifest's resource requests are minimums: they can raise
        those defaults but never shrink the build sandbox. The sandbox stays on
        while the Module is on.
      </p>
      {view.error && (
        <div className="mt-3 text-xs" role="alert">
          <p>{view.error.message}</p>
          <Button onClick={retry} size="xs" variant="outline">
            Try again
          </Button>
        </div>
      )}
      {view.isPending && (
        <p className="mt-3 text-muted-foreground text-xs">Loading settings…</p>
      )}
      {view.data && (
        <SettingsForm key={moduleId} moduleId={moduleId} view={view.data} />
      )}
    </section>
  );
}

/**
 * The fields start from the saved values; a later refetch never clobbers
 * what the user is typing, and a save resets them to what it saved.
 */
function SettingsForm({
  moduleId,
  view,
}: {
  moduleId: string;
  view: ModuleSettingsView;
}) {
  const api = worksApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(view));
  const [invalid, setInvalid] = useState<Problems>([]);
  const save = useMutation(
    api.moduleSettings.set.mutationOptions({
      onSuccess: (saved) => {
        queryClient.setQueryData(
          api.moduleSettings.get.queryKey({ input: { id: moduleId } }),
          saved
        );
        setDraft(draftOf(saved));
      },
    })
  );
  const change = useCallback((key: string, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }, []);
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const values: Record<string, number> = {};
      const problems: { key: string; message: string }[] = [];
      for (const [key, text] of Object.entries(draft)) {
        if (text.trim() === "") {
          continue;
        }
        const value = Number(text);
        if (Number.isFinite(value) && value > 0) {
          values[key] = value;
        } else {
          problems.push({ key, message: "Enter a positive number." });
        }
      }
      setInvalid(problems);
      if (problems.length === 0) {
        save.mutate({ id: moduleId, values });
      }
    },
    [draft, moduleId, save.mutate]
  );
  const problems = [
    ...invalid,
    ...refusedSettings(save.error),
    ...view.problems,
  ];
  const problemOf = (key: string) =>
    problems.find((problem) => problem.key === key)?.message;
  const general = problems.filter(
    (problem) =>
      !view.keys.some((description) => description.key === problem.key)
  );
  return (
    <form className="mt-3" onSubmit={submit}>
      {(general.length > 0 || save.error) && (
        <div className="mb-2 text-destructive text-xs" role="alert">
          {save.error && <p>{save.error.message}</p>}
          {general.map((problem) => (
            <p key={`${problem.key}:${problem.message}`}>{problem.message}</p>
          ))}
        </div>
      )}
      {view.effective === null && (
        <p className="mb-2 text-destructive text-xs" role="alert">
          This Module's requirements cannot be met with these values.
        </p>
      )}
      <ul aria-label="Settings" className="divide-y divide-border/40">
        {view.keys.map((description) => (
          <SettingRow
            change={change}
            description={description}
            draft={draft[description.key] ?? ""}
            effective={view.effective?.[description.key]}
            key={description.key}
            problem={problemOf(description.key)}
          />
        ))}
      </ul>
      <Button
        className="mt-3"
        disabled={save.isPending}
        size="sm"
        type="submit"
      >
        {save.isPending ? "Saving…" : "Save settings"}
      </Button>
      {save.isSuccess && !save.isPending && (
        <span className="ms-3 text-xs" role="status">
          Settings saved
        </span>
      )}
    </form>
  );
}
