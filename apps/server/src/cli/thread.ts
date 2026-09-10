import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { DEFAULT_THREAD_TITLE } from "../orchestration/threadTitles.ts";
import { resolveTextGenerationProvider } from "../serverSettings.ts";
import { projectLocationFlags } from "./config.ts";
import {
  normalizeWorkspaceRootForProjectCommand,
  resolveProjectTitle,
  runCliMutation,
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

const threadCliUuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));

const createCommand = Command.make("create", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root (defaults to the current directory)."),
    Argument.optional,
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  prompt: Flag.string("prompt").pipe(
    Flag.withDescription("Optional first prompt to start immediately."),
    Flag.optional,
  ),
  provider: Flag.string("provider").pipe(
    Flag.withDescription("Provider instance id for this thread."),
    Flag.optional,
  ),
  model: Flag.string("model").pipe(
    Flag.withDescription("Model id for this thread."),
    Flag.optional,
  ),
  reasoning: Flag.string("reasoning").pipe(
    Flag.withAlias("reasoning-level"),
    Flag.withDescription("Reasoning level for this thread."),
    Flag.optional,
  ),
  fast: Flag.boolean("fast").pipe(
    Flag.withDescription("Use the provider's fast mode or priority service tier."),
    Flag.withDefault(false),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print the created thread as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Create a thread in the running T3 Code server."),
  Command.withHandler((flags) =>
    runCliMutation(
      flags,
      Effect.fn("threadCreateMutation")(function* ({
        snapshot,
        dispatch,
        mode,
        readServerSettings,
      }) {
        if (mode !== "live") {
          return yield* new ThreadCliRunningServerRequiredError();
        }

        const projectIdentifier = Option.getOrElse(flags.project, () => ".").trim();
        const projectById = snapshot.projects.find((project) => project.id === projectIdentifier);
        const workspaceRoot = projectById
          ? projectById.workspaceRoot
          : yield* normalizeWorkspaceRootForProjectCommand(projectIdentifier);
        const existingProject =
          projectById ??
          snapshot.projects.find((project) => project.workspaceRoot === workspaceRoot);
        const serverSettings = resolveTextGenerationProvider(yield* readServerSettings);
        const projectModelSelection = existingProject?.defaultModelSelection;
        const inheritedModelSelection =
          projectModelSelection &&
          isModelSelectionProviderEnabled(serverSettings, projectModelSelection)
            ? projectModelSelection
            : serverSettings.textGenerationModelSelection;
        const defaultModelSelection = yield* resolveModelSelection({
          base: inheritedModelSelection,
          settings: serverSettings,
          provider: Option.getOrUndefined(flags.provider),
          model: Option.getOrUndefined(flags.model),
          reasoning: Option.getOrUndefined(flags.reasoning),
          fast: flags.fast,
        });
        const explicitTitle = Option.getOrUndefined(flags.title)?.trim();
        if (explicitTitle !== undefined && explicitTitle.length === 0) {
          return yield* new ThreadCliTitleEmptyError();
        }
        const prompt = Option.getOrUndefined(flags.prompt);
        const trimmedPrompt = prompt?.trim();
        if (prompt !== undefined && trimmedPrompt?.length === 0) {
          return yield* new ThreadCliPromptEmptyError();
        }

        let projectId: ProjectId;
        let projectTitle: string;
        let projectCreated = false;
        const createdAt = DateTime.formatIso(yield* DateTime.now);

        if (existingProject === undefined) {
          projectId = ProjectId.make(yield* threadCliUuid);
          projectTitle = yield* resolveProjectTitle(workspaceRoot);
          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make(yield* threadCliUuid),
            projectId,
            title: projectTitle,
            workspaceRoot,
            defaultModelSelection,
            createdAt,
          });
          projectCreated = true;
        } else {
          projectId = existingProject.id;
          projectTitle = existingProject.title;
        }

        const title =
          explicitTitle ?? (trimmedPrompt ? truncate(trimmedPrompt) : DEFAULT_THREAD_TITLE);
        const threadId = ThreadId.make(yield* threadCliUuid);
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* threadCliUuid),
          threadId,
          projectId,
          title,
          modelSelection: defaultModelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });

        if (prompt !== undefined) {
          yield* dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* threadCliUuid),
            threadId,
            message: {
              messageId: MessageId.make(yield* threadCliUuid),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            titleSeed: title,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          });
        }

        const result = {
          threadId,
          projectId,
          projectTitle,
          workspaceRoot,
          title,
          modelSelection: defaultModelSelection,
          started: prompt !== undefined,
          projectCreated,
        } as const;

        if (flags.json) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is a presentation DTO.
          return JSON.stringify(result);
        }

        return [
          `${prompt === undefined ? "Created" : "Created and started"} thread ${threadId} (${title}) in ${projectTitle}.`,
          `Provider: ${defaultModelSelection.instanceId} · ${defaultModelSelection.model}`,
          ...(projectCreated ? [`Added ${workspaceRoot} as a project.`] : []),
        ].join("\n");
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([createCommand]),
);
