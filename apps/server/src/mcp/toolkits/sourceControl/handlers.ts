import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SourceControlMcpService } from "../../SourceControlMcpService.ts";
import { SourceControlToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(SourceControlToolkit, {
  t3_git_status: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.status(scope, input.includeCommits)),
    ),
  ),
  t3_git_action: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.action(scope, input)),
    ),
  ),
  t3_git_regenerate_change_request: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.regenerate(scope, input)),
    ),
  ),
  t3_git_stack: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.stack(scope, input)),
    ),
  ),
  t3_git_rewrite_commits: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.rewrite(scope, input.rewrite)),
    ),
  ),
  t3_git_pull: McpToolAccess.actsAsCaller(() =>
    Effect.flatMap(SourceControlMcpService, (service) =>
      Effect.flatMap(McpInvocationContext, (scope) => service.pull(scope)),
    ),
  ),
});
