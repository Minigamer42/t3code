import {
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitRegeneratePullRequestDescriptionInput,
  GitResolvePullRequestResult,
  GitStackManageInput,
  GitStackStatusResult,
  VcsStatusResult,
  GitListRewriteableCommitsResult,
  GitRewriteCommitMessagesInput,
  GitRewriteCommitMessagesResult,
  GitCommitWorkflowScope,
  GitStartCommitWorkflowResult,
  GitWorkflowProgress,
  OrchestratorMcpFailure,
  VcsPullResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { SourceControlMcpService } from "../../SourceControlMcpService.ts";

export const GitActionInput = Schema.Struct(
  Struct.omit(GitRunStackedActionInput.fields, ["cwd", "threadId", "projectId", "actionId"]),
);
export type GitActionInput = typeof GitActionInput.Type;
export const GitRegenerateInput = Schema.Struct(
  Struct.omit(GitRegeneratePullRequestDescriptionInput.fields, ["cwd", "threadId", "projectId"]),
);
export type GitRegenerateInput = typeof GitRegenerateInput.Type;
export const GitStackInput = Schema.Struct(Struct.omit(GitStackManageInput.fields, ["cwd"]));
export type GitStackInput = typeof GitStackInput.Type;
export const GitRewriteInput = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("messages"),
    ...Schema.Struct(Struct.omit(GitRewriteCommitMessagesInput.fields, ["cwd"])).fields,
  }),
  Schema.Struct({
    mode: Schema.Literal("logical"),
    scope: GitCommitWorkflowScope.members[1],
    instructions: GitRunStackedActionInput.fields.instructions,
  }),
]);
export type GitRewriteInput = typeof GitRewriteInput.Type;

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    SourceControlMcpService,
  ],
};
const status = Tool.make("t3_git_status", {
  ...common,
  description:
    "Read this thread's checkout, changes, stack and running Git action. `includeCommits` lists rewriteable commits within the current layer, with HEAD SHA for a guarded rewrite.",
  parameters: Schema.Struct({ includeCommits: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({
    status: VcsStatusResult,
    stack: GitStackStatusResult,
    progress: Schema.NullOr(GitWorkflowProgress),
    commits: Schema.NullOr(GitListRewriteableCommitsResult),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const action = Tool.make("t3_git_action", {
  ...common,
  description:
    "Run a sidebar Git action in THIS thread's checkout. Full-access/default only. `commit` uses logical commits; `commit_push` commits pending changes and pushes; `commit_push_pr` also creates missing PRs/MRs through the current stack layer. `push` only pushes, never creates reviews. `create_pr` publishes existing commits and creates reviews. `create_branch` uses repository naming policy. Commit actions create a feature branch on the main ref or detached HEAD. Optional `instructions` add context; `splitCommits:false` selects one commit. Returns when finished; progress appears in the sidebar and t3_git_status. Created reviews are linked automatically.",
  parameters: GitActionInput,
  success: GitRunStackedActionResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const regenerate = Tool.make("t3_git_regenerate_change_request", {
  ...common,
  description:
    "Regenerate and save this branch's PR/MR title and description using its diff and repository policy. Optional `reference` selects another review; `instructions` add context. Full-access/default only. Does not commit or push.",
  parameters: GitRegenerateInput,
  success: GitResolvePullRequestResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const stack = Tool.make("t3_git_stack", {
  ...common,
  description:
    "Maintain this thread's branch stack: adopt/edit ordered layers (`splitPoints` creates lower layers at commit boundaries, with `expectedHeadSha`; names follow repository policy), update branches locally, continue/abort a paused operation, or untrack. `includeLatestBase:true` includes the remote main ref; otherwise only restack layers. Save/update also sync existing GitLab MR dependencies, preserving manual blockers. Update never pushes or creates reviews. After conflicts are resolved externally, use continue. Inspect t3_git_status first. Full-access/default only.",
  parameters: GitStackInput,
  success: GitStackStatusResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const rewrite = Tool.make("t3_git_rewrite_commits", {
  ...common,
  description:
    "Rewrite only this thread's current stack layer. Read t3_git_status(includeCommits:true) first. `messages` regenerates selected commit messages with expectedHeadSha; `logical` splits/regroups branch or branch_range history, optionally bounded by startCommit/endCommit and expectedHeadSha in scope. Both preserve code and never push. `instructions` add guidance. Full-access/default only.",
  parameters: Schema.Struct({ rewrite: GitRewriteInput }),
  success: Schema.Union([GitRewriteCommitMessagesResult, GitStartCommitWorkflowResult]),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const pull = Tool.make("t3_git_pull", {
  ...common,
  description:
    "Pull this thread's current branch from its configured upstream, using the same workflow as the sidebar. For a branch stack use t3_git_stack(update). Full-access/default only.",
  success: VcsPullResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const SourceControlToolkit = Toolkit.make(status, action, regenerate, stack, rewrite, pull);
