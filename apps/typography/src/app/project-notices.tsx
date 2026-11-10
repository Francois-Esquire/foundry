import { useCallback } from "react";
import { Notice } from "~/ui/controls/notice";
import type { Notice as WorkspaceNotice } from "~/workspace/notices";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";

function ProjectNotice({ notice }: { readonly notice: WorkspaceNotice }) {
  const workspace = useWorkspace();
  const dismiss = useCallback(
    () => workspace.dismissNotice(notice.id),
    [workspace, notice.id]
  );
  return (
    <Notice
      onDismiss={dismiss}
      tone={notice.tone === "error" ? "problem" : "note"}
    >
      {notice.message}
    </Notice>
  );
}

/** The workspace's notices, each on its own line until dismissed. They never block the work. */
export function ProjectNotices() {
  const notices = useWorkspaceState(useCallback((state) => state.notices, []));
  if (notices.length === 0) {
    return null;
  }
  return (
    <section aria-label="Notices" className="ty-app-notices">
      {notices.map((notice) => (
        <ProjectNotice key={notice.id} notice={notice} />
      ))}
    </section>
  );
}
