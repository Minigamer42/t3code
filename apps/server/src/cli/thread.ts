import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
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
        const defaultModelSelection =
          projectModelSelection &&
          isModelSelectionProviderEnabled(serverSettings, projectModelSelection)
            ? projectModelSelection
            : serverSettings.textGenerationModelSelection;
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
