import {
  CiActivity,
  isCiActivityFinished,
  CiPipeline,
  CiJob,
  CommandId,
  GitManagerError,
  SourceControlProviderError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Providers from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as Process from "../vcs/VcsProcess.ts";
import * as Config from "../vcs/CiProjectConfig.ts";
import { forkParked } from "../serverActivation.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";

const Record = Schema.Struct({
  activity: CiActivity,
  config: Config.CiProjectConfig,
  directory: Schema.String,
  notified: Schema.Boolean,
  readFailures: Schema.Number,
  dismissed: Schema.optionalKey(Schema.Boolean),
});
const Records = Schema.Array(Record);
const decodeRecords = Schema.decodeUnknownEffect(Schema.fromJsonString(Records));
const encodeRecords = Schema.encodeEffect(Schema.fromJsonString(Records));
const isProviderError = Schema.is(SourceControlProviderError);
const isManagerError = Schema.is(GitManagerError);
const encodeMatchContext = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      activity: CiActivity,
      pipeline: CiPipeline,
      job: CiJob,
      tracePath: Schema.String,
    }),
  ),
);

type Record = typeof Record.Type;
function visibleRecords(items: readonly Record[]) {
  return items
    .filter((item) => !item.dismissed && item.activity.state !== "passed")
    .filter((item, index) => !isCiActivityFinished(item.activity) || index < 10);
}
const samePipeline = (a: CiActivity["pipeline"], b: CiActivity["pipeline"]) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.sha === b.sha &&
    a.status === b.status &&
    a.url === b.url &&
    a.changeRequest?.number === b.changeRequest?.number &&
    a.changeRequest?.url === b.changeRequest?.url &&
    a.jobs.length === b.jobs.length &&
    a.jobs.every((job, index) => {
      const other = b.jobs[index]!;
      return (
        job.id === other.id &&
        job.name === other.name &&
        job.status === other.status &&
        job.url === other.url &&
        job.allowFailure === other.allowFailure
      );
    }));
export class CiMonitor extends Context.Service<
  CiMonitor,
  {
    readonly withPublication: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly recordPush: (input: {
      cwd: string;
      branch: string;
      remoteName?: string;
      threadId: ThreadId | null;
    }) => Effect.Effect<void, GitManagerError>;
    readonly register: (input: {
      cwd: string;
      host: string;
      repository: string;
      branch: string;
      sha: string;
      localBranch?: string;
      threadId: ThreadId | null;
    }) => Effect.Effect<void, GitManagerError>;
    readonly discoverLocalPushes: (input: {
      readonly cwd: string;
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly branch: string | null;
        readonly worktreePath: string | null;
      }>;
    }) => Effect.Effect<void, GitManagerError>;
    readonly dismiss: (activityId: string) => Effect.Effect<void, GitManagerError>;
    readonly subscribe: Stream.Stream<readonly CiActivity[]>;
    readonly sweep: Effect.Effect<void, GitManagerError>;
    readonly refresh: Effect.Effect<void, GitManagerError>;
    readonly start: (
      wake: (
        activity: CiActivity,
        instructions: string,
        commandId: CommandId,
      ) => Effect.Effect<boolean, GitManagerError>,
      discover?: Effect.Effect<void>,
    ) => Effect.Effect<void, never, import("effect/Scope").Scope>;
  }
>()("t3/ci/CiMonitor") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const process = yield* Process.VcsProcess;
  const git = yield* Git.GitVcsDriver;
  const filename = path.join(stateDir, "ci-activities.json");
  const records = yield* SubscriptionRef.make<readonly Record[]>(
    (yield* fs.exists(filename))
      ? yield* fs.readFileString(filename).pipe(Effect.flatMap(decodeRecords))
      : [],
  );
  const lock = yield* Semaphore.make(1);
  const sweeper = yield* Semaphore.make(1);
  let started = false;
  const publications = new Map<string, number>();
  const discoveryStartedAt = yield* Clock.currentTimeMillis;
  const scannedRepositories = new Map<string, number>();
  let wake:
    | ((
        activity: CiActivity,
        instructions: string,
        id: CommandId,
      ) => Effect.Effect<boolean, GitManagerError>)
    | undefined;
  const save = Effect.fn("CiMonitor.save")(function* (record: Record) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const all = yield* SubscriptionRef.get(records);
        const old = all.find((item) => item.activity.id === record.activity.id);
        if (old?.dismissed && !record.dismissed) return;
        if (old?.activity.state === "superseded" && record.activity.state !== "superseded") return;
        const next = [
          record,
          ...all.filter((item) => item.activity.id !== record.activity.id),
        ].sort((a, b) => b.activity.startedAt - a.activity.startedAt);
        const retained = next.filter(
          (item, index) => !isCiActivityFinished(item.activity) || index < 200,
        );
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(`${filename}.tmp`, yield* encodeRecords(retained), {
          mode: 0o600,
        });
        yield* fs.rename(`${filename}.tmp`, filename);
        yield* SubscriptionRef.set(records, retained);
      }),
    );
  });
  const update = Effect.fn("CiMonitor.update")(function* (
    record: Record,
    patch: Partial<CiActivity>,
  ) {
    const activity = { ...record.activity, ...patch };
    if (
      activity.state === record.activity.state &&
      activity.label === record.activity.label &&
      activity.attempts === record.activity.attempts &&
      samePipeline(activity.pipeline, record.activity.pipeline)
    )
      return record;
    const next = {
      ...record,
      activity: { ...record.activity, ...patch, updatedAt: yield* Clock.currentTimeMillis },
    };
    yield* save(next);
    return next;
  });
  const check = Effect.fn("CiMonitor.check")(function* (record: Record) {
    const activity = record.activity;
    const provider = yield* providers.resolve({ cwd: activity.cwd });
    const api = provider.ci;
    if (!api)
      return yield* update(record, {
        state: "failed",
        label: "CI tracking is not supported by this source control provider.",
      });
    const read = yield* api.read(activity);
    if (!read.current)
      return yield* update(record, {
        state: "superseded",
        label: "Remote branch removed or updated since this push.",
      });
    record = { ...record, readFailures: 0 };
    const pipeline = read.pipeline;
    if (!pipeline) {
      if ((yield* Clock.currentTimeMillis) - activity.startedAt > 30 * 60_000)
        return yield* update(record, {
          state: "failed",
          label: "No pipeline appeared for the pushed revision within 30 minutes.",
        });
      return yield* update(record, { state: "waiting", label: "Waiting for pipeline..." });
    }
    record = yield* update(record, { pipeline });
    if (pipeline.status === "canceled")
      return yield* update(record, { state: "cancelled", label: "Pipeline cancelled" });
    if (pipeline.status === "skipped")
      return yield* update(record, { state: "skipped", label: "Pipeline skipped" });
    if (pipeline.status === "manual")
      return yield* update(record, { state: "waiting", label: "Pipeline needs a manual job" });
    const running = pipeline.jobs.some(
      (job) =>
        !job.allowFailure &&
        [
          "created",
          "pending",
          "running",
          "preparing",
          "waiting_for_resource",
          "scheduled",
        ].includes(job.status),
    );
    if (
      running ||
      ["created", "pending", "running", "preparing", "waiting_for_resource", "scheduled"].includes(
        pipeline.status,
      )
    )
      return yield* update(record, { state: "running", label: "Pipeline running" });
    if (
      pipeline.jobs.some(
        (job) =>
          job.allowFailure &&
          ["pending", "running", "preparing", "waiting_for_resource"].includes(job.status),
      ) &&
      activity.state === "recovering"
    )
      return yield* update(record, { state: "recovering", label: "CI recovery running" });
    if (pipeline.status === "success")
      return yield* update(record, { state: "passed", label: "CI passed" });
    const failed = pipeline.jobs.filter((job) => job.status === "failed" && !job.allowFailure);
    for (const job of failed) {
      for (const [key, rule] of Object.entries(record.config.recovery ?? {})) {
        if (
          !rule.jobs.includes(job.name) ||
          (record.activity.attempts[key] ?? 0) >= rule.maxAttempts
        )
          continue;
        const trace = yield* api.trace({ ...activity, jobId: job.id });
        const matches = yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ci-" });
            const tracePath = path.join(directory, "job.log");
            yield* fs.writeFileString(tracePath, trace, { mode: 0o600 });
            const result = yield* process.run({
              operation: "CiMonitor.classify",
              cwd: record.directory,
              command: rule.match[0],
              args: rule.match.slice(1),
              stdin: yield* encodeMatchContext({ version: 1, activity, pipeline, job, tracePath }),
              allowNonZeroExit: true,
              timeoutMs: 60_000,
              maxOutputBytes: 32_000,
            });
            if (result.exitCode !== 0 && result.exitCode !== 1)
              return yield* new GitManagerError({
                cwd: activity.cwd,
                operation: "ci",
                detail: `CI classifier ${key} failed: ${result.stderr.slice(0, 1000)}`,
              });
            return result.exitCode === 0;
          }),
        );
        if (!matches) continue;
        const fresh = yield* api.read(activity);
        if (
          !fresh.current ||
          fresh.pipeline?.id !== pipeline.id ||
          !fresh.pipeline.jobs.some((item) => item.id === job.id && item.status === "failed")
        )
          return record;
        const latest = (yield* SubscriptionRef.get(records)).find(
          (item) => item.activity.id === activity.id,
        );
        if (latest?.activity.state === "superseded") return latest;
        const action = rule.action;
        const target =
          action.type === "retry-job"
            ? job
            : fresh.pipeline.jobs.find((item) => item.name === action.name);
        if (!target || (action.type === "play-job" && target.status !== "manual"))
          return yield* new GitManagerError({
            cwd: activity.cwd,
            operation: "ci",
            detail: `CI recovery job for ${key} is unavailable.`,
          });
        // Persist before POST: an ambiguous response or restart must not repeat a remote mutation.
        record = yield* update(record, {
          state: "recovering",
          label: `${key}: ${action.type === "play-job" ? "starting" : "retrying"} ${target.name}`,
          attempts: {
            ...record.activity.attempts,
            [key]: (record.activity.attempts[key] ?? 0) + 1,
          },
        });
        yield* api.run({ ...activity, jobId: target.id, action: action.type });
        return record;
      }
    }
    return yield* update(record, {
      state: "failed",
      label: failed.length
        ? `CI failed: ${failed.map((job) => job.name).join(", ")}`
        : `Pipeline ${pipeline.status}`,
    });
  });
  const sweep = Effect.fn("CiMonitor.sweep")(
    function* (refreshFinished: boolean) {
      yield* sweeper.withPermit(
        Effect.gen(function* () {
          const all = yield* SubscriptionRef.get(records);
          yield* Effect.forEach(
            refreshFinished ? visibleRecords(all) : all,
            (record) =>
              Effect.gen(function* () {
                if (
                  record.dismissed ||
                  publications.has(record.activity.cwd) ||
                  record.activity.state === "superseded"
                )
                  return;
                if (refreshFinished || !isCiActivityFinished(record.activity))
                  record = yield* check(record).pipe(
                    Effect.catch((cause) =>
                      Effect.gen(function* () {
                        record =
                          (yield* SubscriptionRef.get(records)).find(
                            (item) => item.activity.id === record.activity.id,
                          ) ?? record;
                        if (record.activity.state === "superseded") return record;
                        const readFailures = record.readFailures + 1;
                        if (isProviderError(cause) && readFailures < 3) {
                          return yield* update(
                            { ...record, readFailures },
                            { label: `CI unavailable; retrying (${readFailures}/3)` },
                          );
                        }
                        return yield* update(record, {
                          state: "failed",
                          label: `CI tracking failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        });
                      }),
                    ),
                  );
                if (
                  record.activity.state !== "failed" ||
                  record.notified ||
                  !record.activity.threadId ||
                  !record.config.onUnresolvedFailure ||
                  !wake
                )
                  return;
                const result = yield* wake(
                  record.activity,
                  record.config.onUnresolvedFailure.instructions,
                  CommandId.make(`ci-failure:${record.activity.id}`),
                ).pipe(
                  Effect.tapError(Effect.logError),
                  Effect.match({
                    onSuccess: (queued) => (queued ? "queued" : "originating thread unavailable"),
                    onFailure: () => "thread notification failed",
                  }),
                );
                if (result !== "queued")
                  record = yield* update(record, {
                    label: `${record.activity.label} · automatic repair paused: ${result}`,
                  });
                yield* save({ ...record, notified: true });
              }),
            { concurrency: 2, discard: true },
          );
        }),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              cwd: stateDir,
              operation: "ci",
              detail: "CI activity state could not be updated.",
              cause,
            }),
        ),
      ),
  );
  const register: CiMonitor["Service"]["register"] = Effect.fn("CiMonitor.register")(
    function* (input) {
      const configured = yield* Config.read(input.cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (!configured) return;
      const id = [input.host, input.repository, input.branch, input.sha]
        .map(encodeURIComponent)
        .join(":");
      const all = yield* SubscriptionRef.get(records);
      if (all.some((item) => item.activity.id === id)) return;
      for (const old of all)
        if (
          old.activity.host === input.host &&
          old.activity.repository === input.repository &&
          old.activity.branch === input.branch &&
          !isCiActivityFinished(old.activity)
        )
          yield* update(old, {
            state: "superseded",
            label: "A newer push superseded this revision.",
          });
      const now = yield* Clock.currentTimeMillis;
      yield* save({
        activity: {
          ...input,
          localBranch: input.localBranch ?? input.branch,
          id,
          state: "waiting",
          label: "Waiting for pipeline...",
          startedAt: now,
          updatedAt: now,
          pipeline: null,
          attempts: {},
        },
        config: configured.config,
        directory: configured.directory,
        notified: false,
        readFailures: 0,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              cwd: input.cwd,
              operation: "ci",
              detail: "Push completed, but CI tracking could not be configured.",
              cause,
            }),
        ),
      ),
  );
  return CiMonitor.of({
    withPublication: Effect.fn("CiMonitor.withPublication")(
      <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => publications.set(cwd, (publications.get(cwd) ?? 0) + 1)),
          () => effect,
          () =>
            Effect.sync(() => {
              const remaining = (publications.get(cwd) ?? 1) - 1;
              if (remaining === 0) publications.delete(cwd);
              else publications.set(cwd, remaining);
            }),
        ),
    ),
    register,
    recordPush: Effect.fn("CiMonitor.recordPush")(
      function* (input) {
        if (
          !(yield* Config.read(input.cwd).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ))
        )
          return;
        const target = input.remoteName
          ? { remoteName: input.remoteName, branchName: input.branch }
          : yield* git.resolvePushTarget(input.cwd, { branch: input.branch, hasUpstream: true });
        if (!target)
          return yield* new GitManagerError({
            cwd: input.cwd,
            operation: "ci",
            detail: "Push completed, but its destination could not be identified for CI tracking.",
          });
        const remoteUrl = (yield* git.execute({
          cwd: input.cwd,
          operation: "ci",
          args: ["remote", "get-url", "--push", target.remoteName],
        })).stdout.trim();
        const host = parseGitRemoteHost(remoteUrl)?.host;
        const repository = repositoryPathFromRemoteUrl(remoteUrl);
        if (!host || !repository)
          return yield* new GitManagerError({
            cwd: input.cwd,
            operation: "ci",
            detail: "Push completed, but its remote could not be identified for CI tracking.",
          });
        const sha = (yield* git.execute({
          cwd: input.cwd,
          operation: "ci",
          args: ["rev-parse", `refs/heads/${input.branch}`],
        })).stdout.trim();
        yield* register({
          cwd: input.cwd,
          branch: target.branchName,
          localBranch: input.branch,
          sha,
          host,
          repository,
          threadId: input.threadId,
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isManagerError(cause)
              ? cause
              : new GitManagerError({
                  cwd: input.cwd,
                  operation: "ci",
                  detail: "Push completed, but CI tracking could not be initialized.",
                  cause,
                }),
          ),
        ),
    ),
    discoverLocalPushes: Effect.fn("CiMonitor.discoverLocalPushes")(
      function* (input: Parameters<CiMonitor["Service"]["discoverLocalPushes"]>[0]) {
        if (
          publications.has(input.cwd) ||
          input.threads.some(
            (thread) => thread.worktreePath && publications.has(thread.worktreePath),
          )
        )
          return;
        const config = yield* Config.read(input.cwd).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (!config) return;
        const common = (yield* git.execute({
          cwd: input.cwd,
          operation: "ci.discover",
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        })).stdout.trim();
        const now = yield* Clock.currentTimeMillis;
        const since = scannedRepositories.get(common) ?? discoveryStartedAt;
        if (scannedRepositories.has(common) && now - since < 10_000) return;
        const result = yield* git.execute({
          cwd: input.cwd,
          operation: "ci.discover",
          args: [
            "reflog",
            "show",
            "--all",
            `--since=@${Math.floor(since / 1000) - 1}`,
            "--format=%gD%x00%H%x00%gs",
          ],
          maxOutputBytes: 1_000_000,
        });
        if (result.stdoutTruncated)
          return yield* new GitManagerError({
            cwd: input.cwd,
            operation: "ci",
            detail: "Local push discovery exceeded the output limit.",
          });
        const pushes = new Map<string, string>();
        for (const line of result.stdout.split("\n")) {
          const [selector, sha, message] = line.split("\0");
          const ref = selector?.replace(/@\{[^}]+\}$/, "");
          if (
            message === "update by push" &&
            ref?.startsWith("refs/remotes/") &&
            sha &&
            !pushes.has(ref)
          )
            pushes.set(ref, sha);
        }
        if (pushes.size) {
          const remotes = (yield* git.execute({
            cwd: input.cwd,
            operation: "ci.discover",
            args: ["remote"],
          })).stdout
            .trim()
            .split("\n")
            .sort((a, b) => b.length - a.length);
          const heads = yield* git.execute({
            cwd: input.cwd,
            operation: "ci.discover",
            args: [
              "for-each-ref",
              "--format=%(refname:strip=2)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)%00%(push:remoteref)",
              "refs/heads",
            ],
            maxOutputBytes: 1_000_000,
          });
          if (heads.stdoutTruncated)
            return yield* new GitManagerError({
              cwd: input.cwd,
              operation: "ci",
              detail: "Local branch discovery exceeded the output limit.",
            });
          const mappings = heads.stdout
            .trim()
            .split("\n")
            .map((line) => line.split("\0"));
          for (const [ref, sha] of pushes) {
            const remote = remotes.find((name) => name && ref.startsWith(`refs/remotes/${name}/`));
            if (!remote) continue;
            const branch = ref.slice(`refs/remotes/${remote}/`.length);
            const branches = mappings
              .filter(
                ([local, upstreamRemote, upstreamRef, pushRemote, pushRef]) =>
                  (pushRemote || upstreamRemote) === remote &&
                  (pushRef || upstreamRef || `refs/heads/${local}`) === `refs/heads/${branch}`,
              )
              .map(([local]) => local!);
            const matching = input.threads.filter(
              (thread) => thread.branch !== null && branches.includes(thread.branch),
            );
            const thread = matching.length === 1 ? matching[0] : undefined;
            const localBranch = thread?.branch ?? (branches.length === 1 ? branches[0]! : branch);
            const remoteUrl = (yield* git.execute({
              cwd: input.cwd,
              operation: "ci.discover",
              args: ["remote", "get-url", "--push", remote],
            })).stdout.trim();
            const host = parseGitRemoteHost(remoteUrl)?.host;
            const repository = repositoryPathFromRemoteUrl(remoteUrl);
            if (!host || !repository)
              return yield* new GitManagerError({
                cwd: input.cwd,
                operation: "ci",
                detail: "Local push remote could not be identified for CI tracking.",
              });
            yield* register({
              cwd: thread?.worktreePath ?? input.cwd,
              branch,
              localBranch,
              sha,
              host,
              repository,
              threadId: thread?.id ?? null,
            });
          }
        }
        scannedRepositories.set(common, now);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isManagerError(cause)
              ? cause
              : new GitManagerError({
                  cwd: input.cwd,
                  operation: "ci",
                  detail: "Local push discovery failed.",
                  cause,
                }),
          ),
        ),
    ),
    dismiss: Effect.fn("CiMonitor.dismiss")(
      function* (activityId: string) {
        const record = (yield* SubscriptionRef.get(records)).find(
          (item) => item.activity.id === activityId,
        );
        if (!record || record.dismissed) return;
        if (!isCiActivityFinished(record.activity))
          return yield* new GitManagerError({
            cwd: record.activity.cwd,
            operation: "ci",
            detail: "Running CI activities cannot be dismissed.",
          });
        yield* save({ ...record, dismissed: true });
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isManagerError(cause)
              ? cause
              : new GitManagerError({
                  cwd: stateDir,
                  operation: "ci",
                  detail: "CI activity could not be dismissed.",
                  cause,
                }),
          ),
        ),
    ),
    subscribe: SubscriptionRef.changes(records).pipe(
      Stream.map((items) => visibleRecords(items).map((item) => item.activity)),
    ),
    refresh: sweep(true),
    sweep: sweep(false),
    start: Effect.fn("CiMonitor.start")(function* (onFailure, discover) {
      if (started) return;
      started = true;
      wake = onFailure;
      yield* forkParked(
        (discover ?? Effect.void).pipe(
          Effect.andThen(sweep(false)),
          Effect.ignore({ log: true }),
          Effect.repeat(Schedule.spaced("20 seconds")),
        ),
      );
    }),
  });
});
export const layer = Layer.effect(CiMonitor, make);
