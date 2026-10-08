import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { worksApi } from "~/app/api/client";
import { VignettePage } from "~/app/layout/page-vignette";

export function HomePage() {
  const modules = useQuery(worksApi().modules.list.queryOptions());
  return (
    <VignettePage viewportClassName="min-h-full">
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <h1 className="font-semibold text-3xl tracking-tight">Your apps</h1>
        <p className="mt-3 text-muted-foreground text-sm">
          Open a module and make it yours.
        </p>
        <Link
          className="mt-6 inline-block text-sm underline underline-offset-4"
          to="/modules"
        >
          Manage modules
        </Link>
        {modules.isPending && <p className="mt-8 text-sm">Loading apps…</p>}
        {modules.error && (
          <p className="mt-8 text-sm" role="alert">
            {modules.error.message}
          </p>
        )}
        {modules.data?.length === 0 && (
          <p className="mt-8 text-muted-foreground text-sm">
            Create or import your first module in the library.
          </p>
        )}
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {modules.data?.map((module) => (
            <Link
              className="rounded-xl border border-border p-5 hover:bg-muted/40"
              key={module.id}
              to={`/m/${encodeURIComponent(module.id)}`}
            >
              <h2 className="font-medium">{module.name}</h2>
              <p className="mt-2 text-muted-foreground text-xs">Open app</p>
            </Link>
          ))}
        </div>
      </div>
    </VignettePage>
  );
}
