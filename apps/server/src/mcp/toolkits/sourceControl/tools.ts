import {
  GitManagerServiceError,
  GitRunStackedActionResult,
  GitStackedAction,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class SourceControlMcpUnavailableError extends Schema.TaggedErrorClass<SourceControlMcpUnavailableError>()(
  "SourceControlMcpUnavailableError",
  {
    reason: Schema.Literals(["capability_missing", "cwd_unavailable"]),
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return this.reason === "cwd_unavailable"
      ? "The source-control tool has no working directory for this agent session."
      : "This MCP credential does not grant source-control access.";
  }
}

export const SourceControlRunActionInput = Schema.Struct({
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
  splitCommits: Schema.optional(Schema.Boolean),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GitWorkflowService.GitWorkflowService,
  Crypto.Crypto,
];

export const SourceControlRunActionTool = Tool.make("source_control_run_action", {
  description:
    "Run T3 Code's configured source-control workflow in this thread's working directory, only when the user explicitly asks to commit, push, or create a change request. Use action=create_pr to push the current branch when needed and create a provider-native change request (for example, a GitLab merge request); use commit_push_pr to commit changes, push, and create one. Repository .t3code instructions, change-request templates, branch naming, hooks, provider credentials, and the server's text-generation settings are applied automatically.",
  parameters: SourceControlRunActionInput,
  success: GitRunStackedActionResult,
  failure: Schema.Union([SourceControlMcpUnavailableError, GitManagerServiceError]),
  dependencies,
})
  .annotate(Tool.Title, "Run source-control action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SourceControlToolkit = Toolkit.make(SourceControlRunActionTool);
