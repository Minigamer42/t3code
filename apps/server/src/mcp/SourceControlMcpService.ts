import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type GitWorkflowProgress,
  type GitListRewriteableCommitsResult,
  type VcsStatusResult,
  type GitStackStatusResult,
  type GitRunStackedActionResult,
  type GitResolvePullRequestResult,
  type GitRewriteCommitMessagesResult,
  type GitStartCommitWorkflowResult,
  type VcsPullResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as CommitWorkflow from "../git/CommitWorkflowService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as VcsStatus from "../vcs/VcsStatusBroadcaster.ts";
import { linkCreatedPullRequest, linkStackPullRequests } from "../git/linkCreatedPullRequest.ts";
import { refreshPushedPullRequests } from "../git/refreshPushedPullRequests.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, loadCaller } from "./threadAccess.ts";
import type {
  GitActionInput,
  GitRegenerateInput,
  GitRewriteInput,
  GitStackInput,
} from "./toolkits/sourceControl/tools.ts";

type Result<A> = Effect.Effect<A, OrchestratorMcpFailure>;
type Scope = Invocation.McpInvocationScope;
export class SourceControlMcpService extends Context.Service<
  SourceControlMcpService,
  {
    readonly status: (
      scope: Scope,
      includeCommits?: boolean,
    ) => Result<{
      status: VcsStatusResult;
      stack: GitStackStatusResult;
      progress: GitWorkflowProgress | null;
      commits: GitListRewriteableCommitsResult | null;
    }>;
    readonly action: (scope: Scope, input: GitActionInput) => Result<GitRunStackedActionResult>;
    readonly regenerate: (
      scope: Scope,
      input: GitRegenerateInput,
    ) => Result<GitResolvePullRequestResult>;
    readonly stack: (scope: Scope, input: GitStackInput) => Result<GitStackStatusResult>;
    readonly rewrite: (
      scope: Scope,
      input: GitRewriteInput,
    ) => Result<GitRewriteCommitMessagesResult | GitStartCommitWorkflowResult>;
    readonly pull: (scope: Scope) => Result<VcsPullResult>;
  }
>()("t3/mcp/SourceControlMcpService") {}

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (cause: unknown) =>
  isMcpFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: cause instanceof Error ? cause.message : "Git action failed.",
      });
export const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const commits = yield* CommitWorkflow.CommitWorkflowService;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const pullRequests = yield* PullRequests.PullRequestService;
  const broadcaster = yield* VcsStatus.VcsStatusBroadcaster;
  const random = yield* SecureRandom.SecureRandom;
  const commandId = random.uuidV4().pipe(Effect.map((id) => CommandId.make(`git-mcp:${id}`)));
  const workspace = Effect.fn("SourceControlMcpService.workspace")(function* (
    scope: Scope,
    write: boolean,
    reviews = false,
  ) {
    if (
      !scope.capabilities.has("worktree") ||
      (reviews && !scope.capabilities.has("pull-requests"))
    )
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot perform this Git action.",
      });
    yield* Invocation.requireThreadScope(scope, "Git actions");
    const caller = yield* loadCaller().pipe(
      Effect.provideService(Threads.ThreadManagementService, threads),
      Effect.provideService(Invocation.McpInvocationContext, scope),
    );
    if (write) {
      yield* assertLiveCaller(caller);
      yield* assertFullAccess(
        caller,
        "Git writes require a live full-access/default calling thread.",
      );
      if (scope.client?.access === "read-only")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This MCP client has read-only access.",
        });
    }
    const thread = caller.caller;
    if (!thread)
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread is unavailable.",
      });
    const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(failure));
    if (Option.isNone(project))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The calling thread's project is unavailable.",
      });
    return { thread, cwd: thread.worktreePath ?? project.value.workspaceRoot };
  });
  const refresh = Effect.fn("SourceControlMcpService.refresh")((cwd: string) =>
    broadcaster.refreshStatus(cwd).pipe(Effect.ignore({ log: true })),
  );
  const syncBranch = Effect.fn("SourceControlMcpService.syncBranch")(
    function* (expected: OrchestrationV2ThreadShell, cwd: string) {
      const threadId = expected.id;
      const thread = yield* threads.getThreadShell(threadId);
      if (
        !thread ||
        thread.worktreePath !== expected.worktreePath ||
        thread.projectId !== expected.projectId
      )
        return;
      const branch = yield* git.currentBranch(cwd);
      if (branch === thread.branch) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        threadId,
        commandId: yield* commandId,
        branch,
        expectedWorktreePath: thread.worktreePath,
      });
    },
    Effect.ignore({ log: true }),
  );
  const after = Effect.fn("SourceControlMcpService.after")(
    <A, E, R>(cwd: string, thread: OrchestrationV2ThreadShell, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.ensuring(syncBranch(thread, cwd)),
        Effect.ensuring(refresh(cwd)),
        Effect.mapError(failure),
      ),
  );
  return SourceControlMcpService.of({
    status: Effect.fn("SourceControlMcpService.status")(function* (scope, includeCommits = false) {
      const { cwd } = yield* workspace(scope, false);
      return {
        status: yield* git.status({ cwd }).pipe(Effect.mapError(failure)),
        stack: yield* git.stackStatus({ cwd }).pipe(Effect.mapError(failure)),
        progress: Option.getOrNull(
          yield* git
            .subscribeWorkflowProgress({ cwd })
            .pipe(Stream.runHead, Effect.mapError(failure)),
        ),
        commits: includeCommits
          ? yield* git.listRewriteableCommits({ cwd }).pipe(Effect.mapError(failure))
          : null,
      };
    }),
    action: Effect.fn("SourceControlMcpService.action")(function* (scope, input) {
      const { thread, cwd } = yield* workspace(
        scope,
        true,
        input.action === "create_pr" || input.action === "commit_push_pr",
      );
      return yield* after(
        cwd,
        thread,
        git.withActionProgress(cwd, "Git action", (report) =>
          Effect.gen(function* () {
            yield* workspace(
              scope,
              true,
              input.action === "create_pr" || input.action === "commit_push_pr",
            );
            const status = yield* git.localStatus({ cwd });
            const commitAction =
              input.action === "commit" ||
              input.action === "commit_push" ||
              input.action === "commit_push_pr";
            const result = yield* git.runStackedAction(
              {
                ...input,
                cwd,
                threadId: thread.id,
                projectId: thread.projectId,
                actionId: yield* commandId,
                ...(input.featureBranch === undefined &&
                commitAction &&
                (status.refName === null ||
                  (input.action === "commit_push_pr" && status.isDefaultRef))
                  ? { featureBranch: true }
                  : {}),
              },
              {
                onPullRequest: (pr, source) =>
                  linkCreatedPullRequest({
                    threadId: thread.id,
                    result: { pr },
                    source,
                    commandId,
                  }).pipe(
                    Effect.provideService(Orchestrator.OrchestratorV2, engine),
                    Effect.provideService(Projects.ProjectService, projects),
                  ),
                progressReporter: {
                  publish: (event) =>
                    event.kind === "phase_started" ? report(event.label) : Effect.void,
                },
              },
            );
            yield* linkCreatedPullRequest({ threadId: thread.id, result, commandId }).pipe(
              Effect.provideService(Orchestrator.OrchestratorV2, engine),
              Effect.provideService(Projects.ProjectService, projects),
            );
            yield* refreshPushedPullRequests({ cwd, threadId: thread.id }, result).pipe(
              Effect.provideService(Orchestrator.OrchestratorV2, engine),
              Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
              Effect.provideService(PullRequests.PullRequestService, pullRequests),
            );
            return result;
          }),
        ),
      );
    }),
    regenerate: Effect.fn("SourceControlMcpService.regenerate")(function* (scope, input) {
      const { thread, cwd } = yield* workspace(scope, true, true);
      return yield* after(
        cwd,
        thread,
        git.withActionProgress(cwd, "Regenerating review title and description", () =>
          git.regeneratePullRequestDescription({
            ...input,
            cwd,
            threadId: thread.id,
            projectId: thread.projectId,
          }),
        ),
      );
    }),
    stack: Effect.fn("SourceControlMcpService.stack")(function* (scope, input) {
      const { thread, cwd } = yield* workspace(
        scope,
        true,
        input.action !== "abort" && input.action !== "untrack",
      );
      return yield* after(
        cwd,
        thread,
        git.withActionProgress(cwd, "Updating branch stack", () =>
          Effect.gen(function* () {
            const stack = yield* git.manageStack({
              ...input,
              cwd,
              expectedBranch:
                input.expectedBranch === undefined
                  ? yield* git.currentBranch(cwd)
                  : input.expectedBranch,
            });
            if (input.action !== "untrack" && input.action !== "abort")
              yield* linkStackPullRequests({ cwd, stack, threadId: thread.id, commandId }).pipe(
                Effect.provideService(Orchestrator.OrchestratorV2, engine),
                Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
              );
            if (input.action !== "untrack" && input.action !== "abort")
              yield* pullRequests.refreshAfterTurn(thread.projectId, { pushed: true });
            return stack;
          }),
        ),
      );
    }),
    rewrite: Effect.fn("SourceControlMcpService.rewrite")(function* (scope, input) {
      const { thread, cwd } = yield* workspace(scope, true);
      return yield* after(
        cwd,
        thread,
        git.withActionProgress(cwd, "Rewriting commits", () =>
          Effect.gen(function* () {
            if (input.mode === "messages")
              return yield* git.rewriteCommitMessages({ ...input, cwd });
            return yield* commits.start({
              commandId: yield* commandId,
              threadId: thread.id,
              cwd,
              expectedBranch: yield* git.currentBranch(cwd),
              scope: input.scope,
              ...(input.instructions ? { instructions: input.instructions } : {}),
            });
          }),
        ),
      );
    }),
    pull: Effect.fn("SourceControlMcpService.pull")(function* (scope) {
      const { thread, cwd } = yield* workspace(scope, true);
      return yield* after(
        cwd,
        thread,
        git.withActionProgress(cwd, "Pulling branch", () => git.pullCurrentBranch(cwd)),
      );
    }),
  });
});
export const layer = Layer.effect(SourceControlMcpService, make);
