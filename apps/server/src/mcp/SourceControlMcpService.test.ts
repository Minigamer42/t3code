import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "./McpHttpServer.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  SourceControlProviderKind,
  ProviderInstanceId,
  ThreadId,
  GitManagerError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusResult,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as CommitWorkflow from "../git/CommitWorkflowService.ts";
import * as WorkflowProgress from "../git/WorkflowProgress.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as VcsStatus from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as SourceControl from "./SourceControlMcpService.ts";

const threadId = ThreadId.make("git-mcp-test");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("local"),
  requestNamespace: "git-mcp",
  issuedAt: 0,
  client: undefined,
  capabilities: new Set(["worktree", "pull-requests"]),
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const status: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const result: GitRunStackedActionResult = {
  action: "commit_push_pr",
  branch: { status: "created", name: "feature/change" },
  commit: { status: "created" },
  push: { status: "pushed" },
  pr: {
    status: "created",
    url: "https://github.com/acme/app/pull/42",
    number: 42,
    title: "Change",
    baseBranch: "main",
    headBranch: "feature/change",
  },
  toast: { title: "Created PR", cta: { kind: "none" } },
};

const harness = Effect.fn("test.sourceControlHarness")(function* (
  options: {
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
    worktree?: boolean;
    fail?: boolean;
    gate?: Effect.Effect<void>;
  } = {},
) {
  const progress = yield* WorkflowProgress.make;
  const thread = {
    ...liveThreadShell(threadId, options),
    branch: "main",
    worktreePath: options.worktree ? "/repo/worktree" : null,
  };
  const run = vi.fn((input: GitRunStackedActionInput) =>
    (options.gate ?? Effect.void).pipe(
      Effect.andThen(
        options.fail
          ? Effect.fail(
              new GitManagerError({ operation: "push", cwd: input.cwd, detail: "Push rejected" }),
            )
          : Effect.succeed(result),
      ),
    ),
  );
  const dispatch = vi.fn(() => Effect.succeed({ sequence: 1, storedEvents: [] }));
  const link = vi.fn(() => Effect.succeed({ sequence: 1, storedEvents: [] }));
  const refresh = vi.fn(() => Effect.succeed(status));
  const refreshReviews = vi.fn(() => Effect.void);
  const regenerate = vi.fn(() =>
    Effect.succeed({
      pullRequest: {
        number: 42,
        title: "Fresh",
        url: "https://github.com/acme/app/pull/42",
        baseBranch: "main",
        headBranch: "feature/change",
        state: "open" as const,
      },
    }),
  );
  const project = {
    id: thread.projectId,
    title: "Test",
    workspaceRoot: "/repo/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    repositoryIdentity: {
      provider: SourceControlProviderKind.make("github"),
      canonicalKey: "github.com/acme/app",
      displayName: "acme/app",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/app.git",
      },
    },
  };
  const service = yield* SourceControl.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          localStatus: () => Effect.succeed(status),
          currentBranch: () => Effect.succeed("feature/change"),
          runStackedAction: run,
          withActionProgress: progress.withActivity,
          regeneratePullRequestDescription: regenerate,
          subscribeWorkflowProgress: ({ cwd }) => progress.subscribe(cwd),
        }),
        Layer.mock(CommitWorkflow.CommitWorkflowService)({}),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(thread),
          dispatch,
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeedSome(project),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () => Effect.succeed(thread),
          dispatch: link,
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(PullRequests.PullRequestService)({ refreshAfterTurn: refreshReviews }),
        Layer.mock(VcsStatus.VcsStatusBroadcaster)({ refreshStatus: refresh }),
      ),
    ),
  );
  return { service, progress, run, dispatch, link, refresh, refreshReviews, regenerate };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Git MCP actions", (it) => {
  it.effect.each([false, true])(
    "uses the calling thread's checkout, links reviews and preserves context (worktree: %s)",
    (worktree) =>
      Effect.gen(function* () {
        const h = yield* harness({ worktree });
        const output = yield* h.service.action(scope, {
          action: "commit_push_pr",
          instructions: "Explain the migration.",
          filePaths: ["src/api.ts"],
        });
        expect(output).toEqual(result);
        expect(h.run).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: worktree ? "/repo/worktree" : "/repo/project",
            threadId,
            featureBranch: true,
            instructions: "Explain the migration.",
            filePaths: ["src/api.ts"],
          }),
          expect.anything(),
        );
        expect(h.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.metadata.update",
            threadId,
            branch: "feature/change",
          }),
        );
        expect(h.link).toHaveBeenCalledWith(
          expect.objectContaining({ type: "thread.pull-request.link", threadId, number: 42 }),
        );
        expect(h.refreshReviews).toHaveBeenCalled();
        expect(h.refresh).toHaveBeenCalled();
      }),
  );
  it.effect.each([
    { runtimeMode: "approval-required" as const },
    { runtimeMode: "auto-accept-edits" as const },
    { runtimeMode: "auto" as const },
    { interactionMode: "plan" as const },
  ])("rejects Git writes that bypass caller modes: %j", (options) =>
    Effect.gen(function* () {
      const h = yield* harness(options);
      const error = yield* h.service.action(scope, { action: "commit" }).pipe(Effect.flip);
      expect(error.code).toBe("capability_denied");
      expect(h.run).not.toHaveBeenCalled();
    }),
  );
  it.effect.each(["commit", "commit_push_pr"] as const)("checks capabilities for %s", (action) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const capabilities = action === "commit" ? new Set<never>() : new Set(["worktree"] as const);
      expect(
        (yield* h.service.action({ ...scope, capabilities }, { action }).pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(
        (yield* h.service
          .stack({ ...scope, capabilities: new Set(["worktree"]) }, { action: "update" })
          .pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(h.run).not.toHaveBeenCalled();
    }),
  );
  it.effect("retains shared running state until completion and refreshes partial failures", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const h = yield* harness({
        fail: true,
        gate: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
      });
      const job = yield* h.service
        .action(scope, { action: "push" })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(job));
      const active = Option.getOrNull(
        yield* h.progress.subscribe("/repo/project").pipe(Stream.runHead),
      );
      expect(active).toMatchObject({ state: "running", activity: { label: "Git action" } });
      expect(
        (yield* h.service.action(scope, { action: "push" }).pipe(Effect.flip)).message,
      ).toContain("already running");
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(job);
      expect(
        Option.getOrNull(yield* h.progress.subscribe("/repo/project").pipe(Stream.runHead)),
      ).toMatchObject({ state: "failed" });
      expect(h.refresh).toHaveBeenCalledWith("/repo/project");
    }).pipe(Effect.scoped),
  );
  it.effect("passes regeneration context to the same review workflow", () =>
    Effect.gen(function* () {
      const h = yield* harness({ worktree: true });
      yield* h.service.regenerate(scope, {
        reference: "https://github.com/acme/app/pull/42",
        instructions: "Explain rollout.",
      });
      expect(h.regenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo/worktree",
          threadId,
          instructions: "Explain rollout.",
        }),
      );
    }),
  );
  it.effect("advertises callable Git tools and rejects agent-supplied checkout overrides", () =>
    Effect.gen(function* () {
      const h = yield* harness({ worktree: true });
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        expect(server.tools.map(({ tool }) => tool.name)).toEqual(
          expect.arrayContaining([
            "t3_git_action",
            "t3_git_status",
            "t3_git_regenerate_change_request",
            "t3_git_stack",
            "t3_git_rewrite_commits",
            "t3_git_pull",
          ]),
        );
        const rejected = yield* server
          .callTool({
            name: "t3_git_action",
            arguments: {
              action: "commit_push_pr",
              cwd: "/other/checkout",
              threadId: "other-thread",
              instructions: "Explain the migration.",
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.flip,
          );
        expect(rejected).toMatchObject({ code: -32602 });
        expect(h.run).not.toHaveBeenCalled();
        const result = yield* server
          .callTool({
            name: "t3_git_action",
            arguments: {
              action: "commit_push_pr",
              instructions: "Explain the migration.",
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).not.toBe(true);
        expect(h.run.mock.calls[0]?.[0]).toMatchObject({
          cwd: "/repo/worktree",
          threadId,
          instructions: "Explain the migration.",
        });
      }).pipe(
        Effect.provide(
          McpHttpServer.layerSourceControlToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(Layer.succeed(SourceControl.SourceControlMcpService, h.service)),
            Layer.provide(
              Layer.mock(Threads.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
            ),
          ),
        ),
      );
    }),
  );
});
