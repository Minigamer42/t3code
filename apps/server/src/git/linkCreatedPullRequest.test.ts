import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type GitRunStackedActionResult,
  type GitStackStatusResult,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type OrchestrationProjectShell,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { refreshPushedPullRequests } from "./refreshPushedPullRequests.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import {
  createdPullRequestKey,
  linkCreatedPullRequest,
  linkStackPullRequests,
} from "./linkCreatedPullRequest.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const commandId = Effect.succeed(CommandId.make("server:pr-created-link:test"));

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.acme.test/platform/api",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.acme.test:Platform/API.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "Platform/API",
    owner: "Platform",
    name: "API",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread: PullRequestTestThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
};

function prResult(pr: GitRunStackedActionResult["pr"]): Pick<GitRunStackedActionResult, "pr"> {
  return { pr };
}

const layerDependenciesFor = (
  dispatch: Orchestrator.OrchestratorV2Shape["dispatch"],
  threadShell: PullRequestTestThread | null = thread,
  completed = false,
) =>
  Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({ getShell: () => Effect.succeedSome(project) }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedSome(project),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () =>
        Effect.succeed(
          threadShell
            ? {
                ...v2PullRequestThread(threadShell),
                ...(completed ? { latestRunId: RunId.make("completed-run") } : {}),
              }
            : null,
        ),
      getPullRequestSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          threads: threadShell ? [v2PullRequestThread(threadShell)] : [],
        }),
      dispatch,
    }),
  );

const recordingDispatch = Effect.fn("recordingDispatch")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  return { commands, dispatch };
});

describe("createdPullRequestKey", () => {
  it("reads host and repository from the URL when it is recognisable", () => {
    expect(
      createdPullRequestKey(
        prResult({
          status: "created",
          number: 12,
          url: "https://github.com/Other/Fork/pull/12",
        }),
        project,
      ),
    ).toEqual({
      host: "github.com",
      repository: "other/fork",
      number: 12,
      url: "https://github.com/Other/Fork/pull/12",
    });
  });

  it("falls back to the project's host and repository for an unreadable URL", () => {
    expect(
      createdPullRequestKey(
        prResult({ status: "opened_existing", number: 3, url: "https://ghe.internal/x/3" }),
        project,
      ),
    ).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 3,
      url: "https://ghe.internal/x/3",
    });
    expect(
      createdPullRequestKey(
        prResult({ status: "created", number: 3, url: "https://ghe.internal/x/3" }),
        undefined,
      ),
    ).toBeNull();
  });
});

describe("linkCreatedPullRequest", () => {
  it.effect("links a created pull request to the thread with source created", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({
          status: "created",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
        }),
        commandId,
      }).pipe(Effect.provide(layerDependenciesFor(dispatch)));

      expect(yield* Ref.get(commands)).toEqual([
        {
          type: "thread.pull-request.link",
          commandId: "server:pr-created-link:test",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "created",
        },
      ]);
    }),
  );
});

it.effect(
  "refreshes PR readers after a push from a thread or project, but not a local commit",
  () =>
    Effect.gen(function* () {
      const refreshed: Array<[string, boolean | undefined]> = [];
      const layerDependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () => Effect.succeed(v2PullRequestThread(thread)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: (id, options) =>
            Effect.sync(() => {
              refreshed.push([id, options?.pushed]);
            }),
        }),
      );
      yield* refreshPushedPullRequests(
        { cwd: "/worktree", threadId: THREAD_ID },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests(
        { cwd: project.workspaceRoot },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests({ cwd: "/unrelated" }, { push: { status: "pushed" } }).pipe(
        Effect.provide(layerDependencies),
      );
      yield* refreshPushedPullRequests(
        { cwd: project.workspaceRoot, threadId: THREAD_ID },
        { push: { status: "skipped_not_requested" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests(
        { cwd: "/draft-worktree", projectId: PROJECT_ID },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      expect(refreshed).toEqual([
        [PROJECT_ID, true],
        [PROJECT_ID, true],
        [PROJECT_ID, true],
      ]);
    }),
);

it.effect.each([
  "normal",
  "other-worktree",
  "dismissed",
  "linked",
  "settled",
  "reused",
  "coordinator",
  "completed-unowned",
] as const)(
  "links open local stack reviews to matching threads without resurrecting hidden links: %s",
  (mode) =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      const url = (number: number) => `https://gitlab.example/acme/app/-/merge_requests/${number}`;
      let shell: PullRequestTestThread = {
        ...thread,
        branch: "upper",
        settledAt: mode === "settled" ? "2026-08-21T00:00:00.000Z" : null,
        worktreePath: mode === "other-worktree" ? "/elsewhere" : null,
        pullRequests:
          mode === "dismissed" || mode === "linked" || mode === "reused" || mode === "coordinator"
            ? [
                {
                  host: "gitlab.example",
                  repository: "acme/app",
                  number: mode === "reused" ? 99 : 1,
                  url: url(mode === "reused" ? 99 : 1),
                  source: mode === "dismissed" ? "stack-dismissed" : "manual",
                  linkedAt: "2026-01-01T00:00:00.000Z",
                  snapshot: null,
                  stack: null,
                },
              ]
            : [],
      };
      if (mode === "coordinator") {
        shell = {
          ...shell,
          pullRequests: [
            ...shell.pullRequests,
            {
              ...shell.pullRequests[0]!,
              number: 4,
              url: url(4),
              source: "agent",
            },
          ],
        };
      }
      const stack: GitStackStatusResult = {
        managed: true,
        base: "main",
        baseIsDefault: true,
        remote: "origin",
        operation: null,
        layers: ["lower", "upper", "merged", "unrelated"].map((branch, i) => ({
          branch,
          parent: i === 0 || i === 3 ? "main" : "lower",
          headSha: "a".repeat(40),
          needsRestack: false,
          hasChanges: false,
          current: i === 1,
          worktreePath: null,
          pullRequest: { number: i + 1, url: url(i + 1), state: i === 2 ? "merged" : "open" },
        })),
      };
      yield* linkStackPullRequests({ cwd: project.workspaceRoot, stack, commandId }).pipe(
        Effect.provide(layerDependenciesFor(dispatch, shell, mode === "completed-unowned")),
      );
      if (mode === "dismissed")
        yield* linkCreatedPullRequest({
          threadId: THREAD_ID,
          result: { pr: { status: "opened_existing", number: 1, url: url(1) } },
          commandId,
        }).pipe(Effect.provide(layerDependenciesFor(dispatch, shell)));
      expect(
        (yield* Ref.get(commands)).flatMap((command) =>
          command.type === "thread.pull-request.link" ? [[command.number, command.source]] : [],
        ),
      ).toEqual(
        mode === "other-worktree" ||
          mode === "settled" ||
          mode === "reused" ||
          mode === "completed-unowned"
          ? []
          : mode === "normal"
            ? [
                [1, "stack"],
                [2, "stack"],
              ]
            : [[2, "stack"]],
      );
      const beforeRepeat = yield* Ref.get(commands);
      shell = {
        ...shell,
        pullRequests: [
          ...shell.pullRequests,
          ...beforeRepeat.flatMap((command) =>
            command.type === "thread.pull-request.link"
              ? [{ ...command, linkedAt: "2026-08-21T00:00:00.000Z", snapshot: null, stack: null }]
              : [],
          ),
        ],
      };
      yield* linkStackPullRequests({ cwd: project.workspaceRoot, stack, commandId }).pipe(
        Effect.provide(layerDependenciesFor(dispatch, shell, mode === "completed-unowned")),
      );
      expect(yield* Ref.get(commands)).toEqual(beforeRepeat);
    }),
);
