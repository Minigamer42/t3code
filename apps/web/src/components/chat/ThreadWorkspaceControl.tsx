import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { fileBasename } from "@t3tools/shared/path";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const selectCheckoutRefName = (result: AsyncResult.AsyncResult<VcsStatusResult, unknown>) => {
  const status = AsyncResult.getOrElse(result, () => null);
  return status?.isRepo ? status.refName : undefined;
};

/** Rebind an existing conversation; the server detaches its old provider session. */
export function ThreadWorkspaceControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const project = projects.find((project) => project.id === thread?.projectId);
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const checkoutRefName = useEnvironmentQuerySelector(
    thread && cwd ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
    selectCheckoutRefName,
  );
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "change thread workspace",
  );
  const [pending, setPending] = useState(false);
  const [loadWorktrees, setLoadWorktrees] = useState(false);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    loadWorktrees && project
      ? vcsEnvironment.listWorktrees({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  if (!thread) return null;
  const currentBranch = checkoutRefName === undefined ? thread.branch : checkoutRefName;
  const busy = ["preparing", "queued", "starting", "running", "waiting"].includes(
    thread.runtime?.status ?? "idle",
  );
  const disabled = !canOperate || busy || pending;
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <span className="text-xs text-muted-foreground">Change workspace</span>
      <Select
        value={thread.projectId}
        disabled={disabled}
        onValueChange={(value, details) => {
          // Option reconciliation must never reassign a conversation.
          if (details.reason !== "item-press") return;
          const target = projects.find((candidate) => candidate.id === value);
          if (!target || target.id === thread.projectId) return;
          setPending(true);
          void updateMetadata({ environmentId, input: { threadId, projectId: target.id } }).finally(
            () => setPending(false),
          );
        }}
      >
        <SelectTrigger size="sm" aria-label="Thread project">
          <SelectValue>{project?.title ?? "Choose project"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {projects.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={thread.worktreePath ?? project?.workspaceRoot ?? ""}
        disabled={disabled}
        onOpenChange={(open) => {
          if (open) {
            setLoadWorktrees(true);
            if (loadWorktrees) refresh();
          }
        }}
        onValueChange={(value) => {
          const worktree = data?.worktrees.find((candidate) => candidate.path === value);
          if (!worktree || !project) return;
          setPending(true);
          void updateMetadata({
            environmentId,
            input: {
              threadId,
              expectedIdle: true,
              branch: worktree.refName,
              worktreePath: worktree.path === project.workspaceRoot ? null : worktree.path,
            },
          }).finally(() => setPending(false));
        }}
      >
        <SelectTrigger size="sm" aria-label="Thread worktree">
          <SelectValue>
            {fileBasename(thread.worktreePath ?? project?.workspaceRoot ?? "Project checkout")}
            {" · "}
            {currentBranch ?? "Detached HEAD"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {data?.worktrees.map((worktree) => (
            <SelectItem key={worktree.path} value={worktree.path}>
              {fileBasename(worktree.path)} ·{" "}
              {(worktree.path === cwd ? currentBranch : worktree.refName) ?? "Detached HEAD"}
            </SelectItem>
          ))}
          {!data ? (
            <SelectItem value="loading" disabled>
              {error
                ? "Could not load worktrees"
                : isPending
                  ? "Loading worktrees…"
                  : "No worktrees"}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {busy && (
        <p className="text-xs text-muted-foreground">
          Stop the current turn before changing workspace.
        </p>
      )}
    </div>
  );
}
