import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, GitManagerError, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SourceControlToolkitHandlersLive } from "./handlers.ts";
import { SourceControlToolkit } from "./tools.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-source-control-test"),
  threadId: ThreadId.make("thread-source-control-test"),
  providerSessionId: "provider-session-source-control-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  cwd: "/projects/jobagent-worktree",
  capabilities: new Set(["preview", "source-control"]),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "source-control-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const result = {
  action: "create_pr" as const,
  branch: { status: "skipped_not_requested" as const },
  commit: { status: "skipped_not_requested" as const },
  push: {
    status: "pushed" as const,
    branch: "feature/test",
    upstreamBranch: "origin/feature/test",
    setUpstream: true,
  },
  pr: {
    status: "created" as const,
    url: "https://gitlab.example.test/group/jobagent/-/merge_requests/12",
    number: 12,
    baseBranch: "main",
    headBranch: "feature/test",
    title: "Test merge request",
  },
  toast: {
    title: "Merge request created",
    cta: {
      kind: "open_pr" as const,
      label: "View MR",
      url: "https://gitlab.example.test/group/jobagent/-/merge_requests/12",
    },
  },
};

function makeTestLayer(
  runStackedAction: GitWorkflowService.GitWorkflowService["Service"]["runStackedAction"],
) {
  return McpServer.toolkit(SourceControlToolkit).pipe(
    Layer.provide(SourceControlToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        runStackedAction,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
}

it.effect("runs the configured action in the provider session working directory", () => {
  let received:
    | Parameters<GitWorkflowService.GitWorkflowService["Service"]["runStackedAction"]>[0]
    | undefined;
  const runStackedAction: GitWorkflowService.GitWorkflowService["Service"]["runStackedAction"] = (
    input,
  ) =>
    Effect.sync(() => {
      received = input;
      return result;
    });

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find(({ tool }) => tool.name === "source_control_run_action");
    expect(tool?.tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });

    const response = yield* server
      .callTool({ name: "source_control_run_action", arguments: { action: "create_pr" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(result);
    expect(received).toMatchObject({
      cwd: invocation.cwd,
      action: "create_pr",
    });
    expect(received?.actionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  }).pipe(Effect.provide(makeTestLayer(runStackedAction)));
});

it.effect("rejects credentials without source-control capability", () => {
  let callCount = 0;
  const runStackedAction: GitWorkflowService.GitWorkflowService["Service"]["runStackedAction"] =
    () =>
      Effect.sync(() => {
        callCount += 1;
        return result;
      });

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const response = yield* server
      .callTool({ name: "source_control_run_action", arguments: { action: "create_pr" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set<McpInvocationContext.McpCapability>(["preview"]),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect(response.content[0]?.type === "text" ? response.content[0].text : "").toContain(
      "This MCP credential does not grant source-control access.",
    );
    expect(callCount).toBe(0);
  }).pipe(Effect.provide(makeTestLayer(runStackedAction)));
});

it.effect("returns source-control workflow failures to the agent", () => {
  const runStackedAction: GitWorkflowService.GitWorkflowService["Service"]["runStackedAction"] = (
    input,
  ) =>
    Effect.fail(
      new GitManagerError({
        operation: "runStackedAction",
        cwd: input.cwd,
        detail: "Commit local changes before creating a merge request.",
      }),
    );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const response = yield* server
      .callTool({ name: "source_control_run_action", arguments: { action: "create_pr" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.type === "text" ? response.content[0].text : "").toContain(
      "Commit local changes before creating a merge request.",
    );
  }).pipe(Effect.provide(makeTestLayer(runStackedAction)));
});
