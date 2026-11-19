import {
  type CommandId,
  type GitRunStackedActionResult,
  type OrchestrationProjectShell,
  type ThreadId,
  type GitStackStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export interface CreatedPullRequestKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export function createdPullRequestKey(
  result: Pick<GitRunStackedActionResult, "pr">,
  project: OrchestrationProjectShell | undefined,
): CreatedPullRequestKey | null {
  const { status, number, url } = result.pr;
  if ((status !== "created" && status !== "opened_existing") || number === undefined || !url) {
    return null;
  }
  const parsed = sourceControlDefinitions.parseChangeRequestUrl(url)?.link;
  if (parsed !== undefined) {
    return { host: parsed.host, repository: parsed.repository, number: parsed.number, url };
  }
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider;
  const repository = sourceControlDefinitions.repositorySelector(identity);
  if (!identity || kind === undefined || repository === null) return null;
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    repository: repository.toLowerCase(),
    number,
    url,
  };
}

/**
 * Never fails: the git action already succeeded and its result is on its way to the client, so
 * a link that cannot be made is logged and dropped.
 */
export const linkCreatedPullRequest: <E>(input: {
  readonly threadId: ThreadId;
  readonly result: Pick<GitRunStackedActionResult, "pr">;
  readonly source?: "created" | "stack";
  readonly commandId: Effect.Effect<CommandId, E>;
}) => Effect.Effect<void, never, Orchestrator.OrchestratorV2 | ProjectService.ProjectService> =
  Effect.fn("linkCreatedPullRequest")(
    function* <E>(input: {
      readonly threadId: ThreadId;
      readonly result: Pick<GitRunStackedActionResult, "pr">;
      readonly source?: "created" | "stack";
      readonly commandId: Effect.Effect<CommandId, E>;
    }) {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectService.ProjectService;
      const thread = yield* engine
        .getThreadShell(input.threadId)
        .pipe(Effect.map(Option.fromNullishOr));
      if (Option.isNone(thread)) return;
      const project = Option.getOrUndefined(yield* projects.getShell(thread.value.projectId));
      const key = createdPullRequestKey(input.result, project);
      if (key === null) return;
      if (
        thread.value.pullRequests?.some(
          (link) => threadPullRequestKeyOf(link) === threadPullRequestKeyOf(key),
        )
      )
        return;
      const commandId = yield* input.commandId;
      yield* engine
        .dispatch({
          type: "thread.pull-request.link",
          commandId,
          threadId: input.threadId,
          ...key,
          source: input.source ?? "created",
        })
        .pipe(Effect.asVoid);
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("failed to link created pull request to thread", {
                threadId: input.threadId,
              }),
        ),
      ),
  );

export const linkStackPullRequests = Effect.fn("linkStackPullRequests")(
  function* <E>(input: {
    readonly cwd: string;
    readonly stack: GitStackStatusResult;
    readonly threadId?: ThreadId;
    readonly commandId: Effect.Effect<CommandId, E>;
  }) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const snapshot = yield* engine.getPullRequestSnapshot(
      input.threadId === undefined ? { unsettledOnly: true } : { threadId: input.threadId },
    );
    const branches = new Set(input.stack.layers.map((layer) => layer.branch));
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null || !thread.branch || !branches.has(thread.branch)) continue;
      const current = yield* engine.getThreadShell(thread.id);
      if (
        !current ||
        current.archivedAt !== null ||
        current.settledAt !== null ||
        current.settledOverride === "settled" ||
        current.projectId !== thread.projectId ||
        current.branch !== thread.branch ||
        current.worktreePath !== thread.worktreePath
      )
        continue;
      const project = yield* projects.getShell(current.projectId);
      if (
        Option.isNone(project) ||
        (current.worktreePath ?? project.value.workspaceRoot) !== input.cwd
      )
        continue;
      const links = current.pullRequests ?? [];
      const owned = new Set(
        links
          .filter(
            (link) =>
              link.source === "created" ||
              link.source === "manual" ||
              link.source === "agent" ||
              link.watch !== undefined,
          )
          .map(threadPullRequestKeyOf),
      );
      if (owned.size === 0 && current.latestRunId !== null && current.activeRunId === null)
        continue;
      const related = new Set<string>();
      for (const layer of input.stack.layers) {
        const key =
          layer.pullRequest &&
          sourceControlDefinitions.parseChangeRequestUrl(layer.pullRequest.url)?.link;
        if (
          owned.size > 0
            ? key && owned.has(threadPullRequestKeyOf(key))
            : layer.branch === current.branch
        ) {
          related.add(layer.branch);
        }
      }
      // The default base joins independent tickets; only layer-to-layer edges establish dependency.
      const neighbors = new Map<string, string[]>();
      for (const layer of input.stack.layers) {
        if (!branches.has(layer.parent)) continue;
        neighbors.set(layer.branch, [...(neighbors.get(layer.branch) ?? []), layer.parent]);
        neighbors.set(layer.parent, [...(neighbors.get(layer.parent) ?? []), layer.branch]);
      }
      const pending = [...related];
      for (let index = 0; index < pending.length; index += 1) {
        for (const branch of neighbors.get(pending[index]!) ?? []) {
          if (related.has(branch)) continue;
          related.add(branch);
          pending.push(branch);
        }
      }
      const known = new Set(links.map(threadPullRequestKeyOf));
      for (const layer of input.stack.layers) {
        if (!related.has(layer.branch)) continue;
        const pr = layer.pullRequest;
        if (pr?.state !== "open") continue;
        const key = sourceControlDefinitions.parseChangeRequestUrl(pr.url)?.link;
        if (!key) continue;
        const identity = threadPullRequestKeyOf(key);
        if (known.has(identity)) continue;
        yield* engine.dispatch({
          type: "thread.pull-request.link",
          threadId: current.id,
          commandId: yield* input.commandId,
          ...key,
          url: pr.url,
          source: "stack",
        });
        known.add(identity);
      }
    }
  },
  Effect.ignore({ log: true }),
);
