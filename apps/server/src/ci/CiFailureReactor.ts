import { ciFailureMessage } from "./ciFailureMessage.ts";
import * as Effect from "effect/Effect";
import { MessageId, GitManagerError } from "@t3tools/contracts";
import * as CiMonitor from "./CiMonitor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CiProjectConfig from "../vcs/CiProjectConfig.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const start = Effect.fn("CiFailureReactor.start")(function* () {
  const monitor = yield* CiMonitor.CiMonitor;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discover = Effect.fn("CiFailureReactor.discoverLocalPushes")(function* () {
    yield* Effect.forEach(
      yield* projects.list(),
      (project) =>
        Effect.gen(function* () {
          if (project.archivedAt !== null) return;
          if (
            !(yield* CiProjectConfig.read(project.workspaceRoot).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ))
          )
            return;
          const snapshot = yield* engine.getShellSnapshot({
            projectId: project.projectId,
            location: "active",
          });
          const checkouts = new Set([
            project.workspaceRoot,
            ...snapshot.threads.flatMap((thread) =>
              thread.worktreePath ? [thread.worktreePath] : [],
            ),
          ]);
          for (const cwd of checkouts)
            yield* monitor.discoverLocalPushes({ cwd, threads: snapshot.threads });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Local CI push discovery failed", {
              projectId: project.projectId,
              cause,
            }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  });
  yield* monitor.start(
    (activity, instructions, commandId) =>
      Effect.gen(function* () {
        if (!activity.threadId) return false;
        const thread = yield* engine.getThreadShell(activity.threadId);
        if (
          !thread ||
          thread.branch !== activity.localBranch ||
          (thread.worktreePath !== null && thread.worktreePath !== activity.cwd)
        )
          return false;
        const branch = (yield* git.execute({
          cwd: activity.cwd,
          operation: "ci.resume",
          args: ["branch", "--show-current"],
        })).stdout.trim();
        const head = (yield* git.execute({
          cwd: activity.cwd,
          operation: "ci.resume",
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();
        const changes = (yield* git.execute({
          cwd: activity.cwd,
          operation: "ci.resume",
          args: ["status", "--porcelain"],
        })).stdout.trim();
        if (branch !== activity.localBranch || head !== activity.sha || changes) return false;
        yield* threads.sendToThread({
          projectId: thread.projectId,
          threadId: thread.id,
          commandId,
          messageId: MessageId.make(`message:${commandId}`),
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
          text: ciFailureMessage(activity, instructions),
        });
        return true;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              cwd: activity.cwd,
              operation: "ci",
              detail: "Could not notify the originating CI thread.",
              cause,
            }),
        ),
      ),
    discover().pipe(Effect.ignore({ log: true })),
  );
});
