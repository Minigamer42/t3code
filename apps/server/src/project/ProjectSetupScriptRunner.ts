// @effect-diagnostics nodeBuiltinImport:off - Node provides the terminal-control-sequence stripper used for surfaced command output.
import * as NodeUtil from "node:util";

import { ProjectId } from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const SETUP_ERROR_OUTPUT_LINE_LIMIT = 20;
const SETUP_ERROR_OUTPUT_BYTE_LIMIT = 4 * 1_024;

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "readSettings", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptCommandError extends Schema.TaggedError<ProjectSetupScriptCommandError>()(
  "ProjectSetupScriptCommandError",
  {
    threadId: Schema.String,
    worktreePath: Schema.String,
    scriptId: Schema.String,
    scriptName: Schema.String,
    terminalId: Schema.String,
    detail: Schema.String,
    exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
    exitSignal: Schema.optional(Schema.NullOr(Schema.Int)),
  },
) {
  override get message(): string {
    return `Project setup action '${this.scriptName}' failed in '${this.worktreePath}': ${this.detail}`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  ProjectSetupScriptCommandError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostPlatform = yield* HostProcessPlatform;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const script = setupProjectScript(resolveProjectScripts(settings, project));
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const terminalResult = yield* Deferred.make<
      | {
          readonly status: "exited";
          readonly exitCode: number | null;
          readonly exitSignal: number | null;
        }
      | { readonly status: "error"; readonly detail: string }
      | { readonly status: "closed" }
    >();
    const outputHistory = new TerminalManager.BoundedTerminalHistory(
      SETUP_ERROR_OUTPUT_LINE_LIMIT,
      "",
      SETUP_ERROR_OUTPUT_BYTE_LIMIT,
    );

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    const commandResult = yield* Effect.acquireUseRelease(
      terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== terminalId) {
          return Effect.void;
        }
        switch (event.type) {
          case "exited":
            return Deferred.succeed(terminalResult, {
              status: "exited",
              exitCode: event.exitCode,
              exitSignal: event.exitSignal,
            }).pipe(Effect.asVoid);
          case "error":
            return Deferred.succeed(terminalResult, {
              status: "error",
              detail: event.message,
            }).pipe(Effect.asVoid);
          case "closed":
            return Deferred.succeed(terminalResult, { status: "closed" }).pipe(Effect.asVoid);
          case "output":
            return Effect.sync(() => outputHistory.append(event.data));
          case "started":
          case "restarted":
          case "cleared":
          case "activity":
            return Effect.void;
        }
      }),
      () =>
        terminalManager
          .write({
            threadId: input.threadId,
            terminalId,
            data:
              hostPlatform === "win32"
                ? `& { ${script.command} }; if ($?) { exit 0 } elseif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }\r`
                : `(${script.command}); exit $?\r`,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "writeCommand",
                  cause,
                }),
            ),
            Effect.andThen(Deferred.await(terminalResult)),
          ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    if (
      commandResult.status !== "exited" ||
      commandResult.exitCode !== 0 ||
      commandResult.exitSignal !== null
    ) {
      const detail =
        commandResult.status === "error"
          ? commandResult.detail
          : commandResult.status === "closed"
            ? "terminal closed before the action completed"
            : commandResult.exitCode !== null
              ? `exited with code ${commandResult.exitCode}`
              : commandResult.exitSignal !== null
                ? `exited from signal ${commandResult.exitSignal}`
                : "exited without a status code";
      const output = NodeUtil.stripVTControlCharacters(outputHistory.value())
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .trim();
      return yield* new ProjectSetupScriptCommandError({
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        detail: output.length > 0 ? `${detail}\n${output}` : detail,
        ...(commandResult.status === "exited"
          ? { exitCode: commandResult.exitCode, exitSignal: commandResult.exitSignal }
          : {}),
      });
    }

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
