import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlusIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { Dialog } from "~/app/components/dialog";
import { Input } from "~/app/components/input";

/**
 * "New Markdown file": a File Artifact the user makes and names, then opens
 * like any other — in an installed editor Module, or with an honest "load an
 * editor" answer when none opens Markdown. It never becomes a Module.
 */
export function NewMarkdownFile() {
  const api = worksApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation(api.artifacts.create.mutationOptions());
  const ask = useCallback(() => {
    create.reset();
    setName("");
    setAsking(true);
  }, [create.reset]);
  const close = useCallback(() => setAsking(false), []);
  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const created = await create.mutateAsync({ name }).catch(() => null);
      if (!created) {
        return;
      }
      setAsking(false);
      await queryClient.invalidateQueries({
        queryKey: api.artifacts.list.key(),
      });
      // The Artifacts route opens it, asking for an editor when needed.
      await navigate(`/artifacts/${encodeURIComponent(created.id)}`);
    },
    [api, create.mutateAsync, name, navigate, queryClient]
  );
  return (
    <>
      <Button onClick={ask} variant="outline">
        <FilePlusIcon />
        New Markdown file
      </Button>
      {asking && (
        <Dialog
          description="A Markdown file on this device. Open it in any editor module that edits Markdown."
          onClose={close}
          title="New Markdown file"
        >
          <form className="mt-4 grid gap-3" onSubmit={submit}>
            <label className="text-sm" htmlFor="markdown-file-name">
              File name
            </label>
            <Input
              id="markdown-file-name"
              maxLength={120}
              onChange={changeName}
              placeholder="Notes"
              required
              value={name}
            />
            {create.error && (
              <p className="text-destructive text-sm" role="alert">
                {create.error.message}
              </p>
            )}
            <Button disabled={create.isPending || !name.trim()} type="submit">
              {create.isPending ? "Creating…" : "Create file"}
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
