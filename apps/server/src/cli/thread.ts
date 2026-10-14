import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAdministrativeScopes,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type ProjectMutation,
  type ModelSelection,
  type ProviderOptionSelection,
  type ProjectSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { createModelSelection } from "@t3tools/shared/model";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  normalizeWorkspaceRootForProjectCommand,
  projectCommandErrorFromLiveServerRequest,
  resolveProjectTitle,
} from "./project.ts";

export class ThreadCliRunningServerRequiredError extends Schema.TaggedError<ThreadCliRunningServerRequiredError>()(
  "ThreadCliRunningServerRequiredError",
  {},
) {
  override get message(): string {
    return "No running T3 Code server found. Start the server first, or pass its --base-dir if it uses a non-default T3 home.";
  }
}

export class ThreadCliTitleEmptyError extends Schema.TaggedError<ThreadCliTitleEmptyError>()(
  "ThreadCliTitleEmptyError",
  {},
) {
  override get message(): string {
    return "Thread title cannot be empty.";
  }
}

export class ThreadCliPromptEmptyError extends Schema.TaggedError<ThreadCliPromptEmptyError>()(
  "ThreadCliPromptEmptyError",
  {},
) {
  override get message(): string {
    return "Thread prompt cannot be empty.";
  }
}

export class ThreadCliModelSelectionError extends Schema.TaggedError<ThreadCliModelSelectionError>()(
  "ThreadCliModelSelectionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const reasoningOptionIdByDriver: Readonly<Record<string, string>> = {
  codex: "reasoningEffort",
  claudeAgent: "effort",
  cursor: "reasoning",
  grok: "reasoningEffort",
  opencode: "variant",
};

function replaceModelOption(
  options: ReadonlyArray<ProviderOptionSelection>,
  replacement: ProviderOptionSelection,
): Array<ProviderOptionSelection> {
  return [...options.filter((option) => option.id !== replacement.id), replacement];
}

function resolveProviderDriver(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderDriverKind {
  const configured = settings.providerInstances[instanceId];
  if (configured !== undefined) {
    return configured.driver;
  }
  return ProviderDriverKind.make(instanceId);
}

function resolveModelSelection(input: {
  readonly base: ModelSelection;
  readonly settings: ServerSettings;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly reasoning: string | undefined;
  readonly fast: boolean;
}): Effect.Effect<ModelSelection, ThreadCliModelSelectionError> {
  return Effect.gen(function* () {
    const explicitProvider = input.provider?.trim();
    if (input.provider !== undefined && explicitProvider?.length === 0) {
      return yield* new ThreadCliModelSelectionError({
        detail: "Provider instance cannot be empty.",
      });
    }
    const explicitModel = input.model?.trim();
    if (input.model !== undefined && explicitModel?.length === 0) {
      return yield* new ThreadCliModelSelectionError({ detail: "Model cannot be empty." });
    }
    const explicitReasoning = input.reasoning?.trim();
    if (input.reasoning !== undefined && explicitReasoning?.length === 0) {
      return yield* new ThreadCliModelSelectionError({
        detail: "Reasoning level cannot be empty.",
      });
    }

    const instanceId = explicitProvider
      ? ProviderInstanceId.make(explicitProvider)
      : input.base.instanceId;
    if (
      explicitProvider &&
      !isModelSelectionProviderEnabled(input.settings, {
        instanceId,
        model: explicitModel ?? input.base.model,
      })
    ) {
      return yield* new ThreadCliModelSelectionError({
        detail: `Provider instance '${explicitProvider}' is not enabled in T3 Code settings.`,
      });
    }
    if (instanceId !== input.base.instanceId && explicitModel === undefined) {
      return yield* new ThreadCliModelSelectionError({
        detail: "--model is required when --provider selects a different provider instance.",
      });
    }

    const model = explicitModel ?? input.base.model;
    let options = instanceId === input.base.instanceId ? [...(input.base.options ?? [])] : [];
    const driver = resolveProviderDriver(input.settings, instanceId);

    if (explicitReasoning !== undefined) {
      const optionId = reasoningOptionIdByDriver[driver];
      if (optionId === undefined) {
        return yield* new ThreadCliModelSelectionError({
          detail: `--reasoning is not supported for provider driver '${driver}'.`,
        });
      }
      options = replaceModelOption(options, { id: optionId, value: explicitReasoning });
    }

    if (input.fast) {
      if (driver === "codex") {
        options = replaceModelOption(options, { id: "serviceTier", value: "priority" });
      } else if (driver === "claudeAgent" || driver === "cursor") {
        options = replaceModelOption(options, { id: "fastMode", value: true });
      } else {
        return yield* new ThreadCliModelSelectionError({
          detail: `--fast is not supported for provider driver '${driver}'.`,
        });
      }
    }

    return createModelSelection(instanceId, model, options);
  });
}

const threadCliUuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));

const threadCreateFlags = {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root (defaults to the current directory)."),
    Argument.optional,
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  prompt: Flag.String("prompt").pipe(
    Flag.withDescription("Optional first prompt to start immediately."),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id for this thread."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model id for this thread."),
    Flag.optional,
  ),
  reasoning: Flag.String("reasoning").pipe(
    Flag.withAlias("reasoning-level"),
    Flag.withDescription("Reasoning level for this thread."),
    Flag.optional,
  ),
  fast: Flag.Boolean("fast").pipe(
    Flag.withDescription("Use the provider's fast mode or priority service tier."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the created thread as JSON."),
    Flag.withDefault(false),
  ),
};

/** Prepare a CLI request against the same project and thread-launch APIs as clients. */
export const createThreadFromCliInput = Effect.fn("createThreadFromCliInput")(function* (
  flags: {
    readonly project: Option.Option<string>;
    readonly title: Option.Option<string>;
    readonly prompt: Option.Option<string>;
    readonly provider: Option.Option<string>;
    readonly model: Option.Option<string>;
    readonly reasoning: Option.Option<string>;
    readonly fast: boolean;
    readonly json: boolean;
  },
  server: {
    readonly snapshot: ProjectSnapshot;
    readonly settings: ServerSettings;
    readonly createProject: (
      input: Extract<ProjectMutation, { type: "project.create" }>,
    ) => Effect.Effect<void, Error>;
    readonly launchThread: (
      input: OrchestrationV2ThreadLaunchInput,
    ) => Effect.Effect<Pick<OrchestrationV2ThreadLaunchResult, "threadId">, Error>;
  },
) {
  const explicitTitle = Option.getOrUndefined(flags.title)?.trim();
  if (explicitTitle !== undefined && explicitTitle.length === 0)
    return yield* new ThreadCliTitleEmptyError();
  const prompt = Option.getOrUndefined(flags.prompt);
  const trimmedPrompt = prompt?.trim();
  if (prompt !== undefined && trimmedPrompt?.length === 0)
    return yield* new ThreadCliPromptEmptyError();
  const identifier = Option.getOrElse(flags.project, () => ".").trim();
  const projects = server.snapshot.projects.filter((project) => project.deletedAt === null);
  const projectById = projects.find((project) => project.id === identifier);
  const workspaceRoot =
    projectById?.workspaceRoot ?? (yield* normalizeWorkspaceRootForProjectCommand(identifier));
  const existingProject =
    projectById ?? projects.find((project) => project.workspaceRoot === workspaceRoot);
  const projectModel = existingProject?.defaultModelSelection;
  const inheritedModelSelection =
    projectModel && isModelSelectionProviderEnabled(server.settings, projectModel)
      ? projectModel
      : server.settings.textGenerationModelSelection;
  const modelSelection = yield* resolveModelSelection({
    base: inheritedModelSelection,
    settings: server.settings,
    provider: Option.getOrUndefined(flags.provider),
    model: Option.getOrUndefined(flags.model),
    reasoning: Option.getOrUndefined(flags.reasoning),
    fast: flags.fast,
  });
  const projectId = existingProject?.id ?? ProjectId.make(yield* threadCliUuid);
  const projectTitle = existingProject?.title ?? (yield* resolveProjectTitle(workspaceRoot));
  if (existingProject === undefined) {
    yield* server.createProject({
      type: "project.create",
      commandId: CommandId.make(yield* threadCliUuid),
      projectId,
      title: projectTitle,
      workspaceRoot,
      defaultModelSelection: modelSelection,
    });
  }
  const title = explicitTitle ?? (trimmedPrompt ? truncate(trimmedPrompt) : "New thread");
  const launched = yield* server.launchThread({
    commandId: CommandId.make(yield* threadCliUuid),
    creationSource: "server",
    threadId: ThreadId.make(yield* threadCliUuid),
    projectId,
    title,
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceStrategy: { type: "root" },
    ...(prompt === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(yield* threadCliUuid),
            text: prompt,
            attachments: [],
          },
        }),
  });
  const result = {
    threadId: launched.threadId,
    projectId,
    projectTitle,
    workspaceRoot,
    title,
    modelSelection,
    started: prompt !== undefined,
    projectCreated: existingProject === undefined,
  };
  if (flags.json) {
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- CLI JSON output is a presentation DTO.
    return JSON.stringify(result);
  }
  return [
    `${prompt === undefined ? "Created" : "Created and started"} thread ${launched.threadId} (${title}) in ${projectTitle}.`,
    `Provider: ${modelSelection.instanceId} · ${modelSelection.model}`,
    ...(existingProject === undefined ? [`Added ${workspaceRoot} as a project.`] : []),
  ].join("\n");
});

const createCommand = Command.make("create", threadCreateFlags).pipe(
  Command.withDescription("Create a thread in the running T3 Code server."),
  Command.withHandler(
    Effect.fn("cli.thread.create")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      yield* Effect.gen(function* () {
        const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isNone(state)) return yield* new ThreadCliRunningServerRequiredError();
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: state.value.origin });
        yield* Effect.acquireUseRelease(
          auth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 thread cli" }),
          (issued) =>
            Effect.scoped(
              Effect.gen(function* () {
                const headers = { authorization: `Bearer ${issued.token}` };
                const snapshot = yield* http.projects.snapshot({ headers }).pipe(
                  Effect.timeout("1 second"),
                  Effect.mapError(() => new ThreadCliRunningServerRequiredError()),
                );
                const ticket = yield* http.auth
                  .webSocketTicket({ headers })
                  .pipe(Effect.mapError(projectCommandErrorFromLiveServerRequest));
                const url = new URL("/ws", state.value.origin);
                url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
                url.searchParams.set("wsTicket", ticket.ticket);
                url.searchParams.set(
                  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
                  String(ORCHESTRATION_PROTOCOL_VERSION),
                );
                const protocol = Layer.effect(
                  RpcClient.Protocol,
                  RpcClient.makeProtocolSocket({
                    retryTransientErrors: false,
                    retryPolicy: Schedule.recurs(0),
                  }),
                ).pipe(
                  Layer.provide(
                    Layer.merge(
                      Socket.layerWebSocket(url.toString()).pipe(
                        Layer.provide(NodeSocket.layerWebSocketConstructor),
                      ),
                      RpcSerialization.layerJson,
                    ),
                  ),
                );
                const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
                const settings = yield* client[WS_METHODS.serverGetSettings]({});
                const output = yield* createThreadFromCliInput(flags, {
                  snapshot,
                  settings,
                  createProject: (payload) =>
                    http.projects
                      .mutate({ headers, payload })
                      .pipe(
                        Effect.asVoid,
                        Effect.mapError(projectCommandErrorFromLiveServerRequest),
                      ),
                  launchThread: (input) => client[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
                });
                yield* Console.log(output);
              }),
            ).pipe(Effect.timeout("30 seconds")),
          (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            EnvironmentAuth.layerRuntime,
            WorkspacePaths.layer,
            FetchHttpClient.layer,
          ).pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([createCommand]),
);
