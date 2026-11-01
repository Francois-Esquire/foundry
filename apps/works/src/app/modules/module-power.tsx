import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { cn } from "~/app/lib/cn";

function statusText(
  state: { on: boolean; sandbox: boolean } | undefined,
  pending: boolean
) {
  if (!state) {
    return "";
  }
  if (pending) {
    return state.on ? "Turning off…" : "Turning on…";
  }
  if (!state.on) {
    return "Off";
  }
  return state.sandbox ? "On · sandbox running" : "On";
}

/**
 * The Module's on/off control. Off stops its apps and removes its sandbox,
 * and refuses chat, builds and apps until it is on again; on keeps its
 * sandbox, once started, even while idle.
 */
export function ModulePowerSwitch({ moduleId }: { moduleId: string }) {
  const api = worksApi();
  const queryClient = useQueryClient();
  const input = { id: moduleId };
  const state = useQuery(api.power.get.queryOptions({ input }));
  const set = useMutation(
    api.power.set.mutationOptions({
      // Access shows whether the app is running, which this changes too.
      onSettled: () =>
        Promise.all(
          [api.power.get, api.access.get].map((procedure) =>
            queryClient.invalidateQueries({
              queryKey: procedure.queryKey({ input: { id: moduleId } }),
            })
          )
        ),
    })
  );
  const on = state.data?.on;
  const toggle = useCallback(() => {
    if (on !== undefined) {
      set.mutate({ id: moduleId, on: !on });
    }
  }, [moduleId, on, set.mutate]);
  const retry = useCallback(() => {
    state.refetch().catch(() => undefined);
  }, [state.refetch]);
  if (state.error) {
    return (
      <div className="flex items-center gap-2 text-xs" role="alert">
        <span className="text-destructive">{state.error.message}</span>
        <Button onClick={retry} size="xs" variant="outline">
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        aria-checked={on ?? false}
        aria-label="Module on"
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          on ? "bg-primary" : "bg-muted"
        )}
        disabled={on === undefined || set.isPending}
        onClick={toggle}
        role="switch"
        type="button"
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-3.5 rounded-full bg-background shadow transition-transform",
            on && "translate-x-4"
          )}
        />
      </button>
      <span
        aria-live="polite"
        className="text-muted-foreground text-xs"
        role="status"
      >
        {statusText(state.data, set.isPending)}
      </span>
      {set.error && (
        <span className="text-destructive text-xs" role="alert">
          {set.error.message}
        </span>
      )}
    </div>
  );
}
