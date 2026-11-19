import { expect, it } from "@effect/vitest";
import { CiActivity, ThreadId, ProjectId, CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Monitor from "./CiMonitor.ts";
import * as Reactor from "./CiFailureReactor.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Engine from "../orchestration-v2/Orchestrator.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

it.effect("queues CI repair only for the unchanged originating checkout", () =>
  Effect.gen(function* () {
    const activity: CiActivity = {
      id: "push",
      cwd: "/repo",
      host: "git.example",
      repository: "acme/app",
      branch: "published",
      localBranch: "local",
      sha: "a".repeat(40),
      threadId: ThreadId.make("origin"),
      state: "failed",
      label: "CI failed: test",
      startedAt: 0,
      updatedAt: 0,
      pipeline: null,
      attempts: {},
    };
    const cases = [
      { branch: "local", sha: activity.sha, changes: "", threadBranch: "local", expected: true },
      { branch: "other", sha: activity.sha, changes: "", threadBranch: "local", expected: false },
      {
        branch: "local",
        sha: "new-local-head",
        changes: "",
        threadBranch: "local",
        expected: false,
      },
      {
        branch: "local",
        sha: activity.sha,
        changes: " M file.txt",
        threadBranch: "local",
        expected: false,
      },
      { branch: "local", sha: activity.sha, changes: "", threadBranch: "other", expected: false },
    ];
    for (const row of cases) {
      const deliveries: Threads.ThreadManagementSendInput[] = [];
      let queued: boolean | undefined;
      const thread = {
        id: activity.threadId!,
        projectId: ProjectId.make("project"),
        branch: row.threadBranch,
        worktreePath: activity.cwd,
      } as NonNullable<
        Effect.Success<ReturnType<Engine.OrchestratorV2["Service"]["getThreadShell"]>>
      >;
      yield* Reactor.start().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Monitor.CiMonitor)({
              start: (wake) =>
                wake(activity, "Inspect the failed job", CommandId.make("ci-failure:push")).pipe(
                  Effect.tap((value) =>
                    Effect.sync(() => {
                      queued = value;
                    }),
                  ),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            }),
            Layer.mock(Engine.OrchestratorV2)({ getThreadShell: () => Effect.succeed(thread) }),
            Layer.mock(Threads.ThreadManagementService)({
              sendToThread: (input) =>
                Effect.sync(() => {
                  deliveries.push(input);
                  return {} as Threads.ThreadManagementSendResult;
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({
              execute: ({ args }) =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout:
                    args[0] === "branch"
                      ? row.branch
                      : args[0] === "rev-parse"
                        ? row.sha
                        : row.changes,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
            }),
          ),
        ),
      );
      expect(queued).toBe(row.expected);
      expect(deliveries).toHaveLength(row.expected ? 1 : 0);
      if (row.expected) {
        expect(deliveries[0]?.threadId).toBe(activity.threadId);
        expect(deliveries[0]?.mode).toBe("queue");
        expect(deliveries[0]?.text).toContain(activity.sha);
      }
    }
  }),
);
