import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SourceControlMcpUnavailableError, SourceControlToolkit } from "./tools.ts";

const handlers = {
  source_control_run_action: Effect.fn("SourceControlToolkit.runAction")(function* (input) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("source-control")) {
      return yield* new SourceControlMcpUnavailableError({
        reason: "capability_missing",
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    }
    if (!invocation.cwd) {
      return yield* new SourceControlMcpUnavailableError({
        reason: "cwd_unavailable",
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    }

    const crypto = yield* Crypto.Crypto;
    const actionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    return yield* gitWorkflow.runStackedAction({
      actionId,
      cwd: invocation.cwd,
      action: input.action,
      ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
      ...(input.splitCommits ? { splitCommits: true } : {}),
      ...(input.featureBranch ? { featureBranch: true } : {}),
      ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
    });
  }),
} satisfies Parameters<typeof SourceControlToolkit.toLayer>[0];

export const SourceControlToolkitHandlersLive = SourceControlToolkit.toLayer(handlers);
