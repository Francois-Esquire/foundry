import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import { VignettePage } from "~/app/layout/page-vignette";

export function HomePage() {
  const api = worksApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery(api.modules.list.queryOptions());
  const [name, setName] = useState("");
  const [importError, setImportError] = useState<string>();
  const create = useMutation(api.modules.create.mutationOptions());
  const importPackage = useMutation(
    api.modules.importPackage.mutationOptions()
  );
  const openCreated = useCallback(
    async (module: { id: string }) => {
      await queryClient.invalidateQueries({ queryKey: api.modules.list.key() });
      await navigate(`/modules/${encodeURIComponent(module.id)}`);
    },
    [api, queryClient, navigate]
  );
  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const module = await create.mutateAsync({ name }).catch(() => null);
      if (module) {
        await openCreated(module);
      }
    },
    [create.mutateAsync, name, openCreated]
  );
  const importFile = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      setImportError(undefined);
      if (file.size > 32 * 1024 * 1024) {
        setImportError("Module packages must be smaller than 32 MB.");
        return;
      }
      try {
        const module = await importPackage.mutateAsync({
          encoded: await file.text(),
        });
        await openCreated(module);
      } catch (error) {
        setImportError(
          error instanceof Error
            ? error.message
            : "Could not import this package."
        );
      }
    },
    [importPackage.mutateAsync, openCreated]
  );
  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const changePackage = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      importFile(event.target.files?.[0]).catch(() => undefined);
      event.target.value = "";
    },
    [importFile]
  );
  const retryList = useCallback(() => {
    list.refetch().catch(() => undefined);
  }, [list.refetch]);
  return (
    <VignettePage
      viewportClassName="relative min-h-full"
      vignette={{
        edgeStrength: 36,
        focalY: 30,
        radiusX: 95,
        radiusY: 90,
        spread: 75,
      }}
    >
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <h1 className="font-sans font-semibold text-3xl tracking-tight">
          Your modules
        </h1>
        <p className="mt-3 text-muted-foreground text-sm">
          Create a module or import a released package. Your library stays on
          this device.
        </p>
        <form className="mt-8 flex max-w-lg items-end gap-3" onSubmit={submit}>
          <div className="flex-1">
            <label className="mb-2 block text-sm" htmlFor="module-name">
              Module name
            </label>
            <Input
              id="module-name"
              maxLength={120}
              onChange={changeName}
              placeholder="My module"
              required
              value={name}
            />
          </div>
          <Button disabled={create.isPending || !name.trim()} type="submit">
            {create.isPending ? "Creating…" : "Create module"}
          </Button>
        </form>
        {create.error && (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="mt-4">
          <label
            className="mb-2 block text-muted-foreground text-sm"
            htmlFor="module-package"
          >
            Import a Foundry module package
          </label>
          <input
            accept=".json,.module,application/json"
            disabled={importPackage.isPending}
            id="module-package"
            onChange={changePackage}
            type="file"
          />
        </div>
        {importError && (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {importError}
          </p>
        )}
        <section aria-label="Module library" className="mt-10">
          {list.isPending && (
            <p className="text-muted-foreground text-sm">Loading modules…</p>
          )}
          {list.error && (
            <div role="alert">
              <p>{list.error.message}</p>
              <Button onClick={retryList} variant="outline">
                Try again
              </Button>
            </div>
          )}
          {list.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No modules yet. Create your first module above.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {list.data?.map((module) => (
              <Link
                className="rounded-xl border border-border p-5 transition-colors hover:bg-muted/40"
                key={module.id}
                to={`/modules/${encodeURIComponent(module.id)}`}
              >
                <h2 className="font-medium">{module.name}</h2>
                <p className="mt-2 break-all text-muted-foreground text-xs">
                  {module.id}
                </p>
                <p className="mt-3 text-muted-foreground text-xs">
                  Updated {new Date(module.updatedAt).toLocaleDateString()}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </VignettePage>
  );
}
