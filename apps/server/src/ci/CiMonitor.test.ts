import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  type CiPipeline,
  type CiActivity,
  SourceControlProviderKind,
  SourceControlProviderError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Providers from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as Process from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Monitor from "./CiMonitor.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ci-test-" });
  yield* fs.makeDirectory(`${cwd}/.t3code`);
  yield* fs.writeFileString(
    `${cwd}/.t3code/ci.json`,
    '{"recovery":{"repair":{"jobs":["test"],"match":["classify"],"action":{"type":"retry-job"},"maxAttempts":1}}}',
  );
  let pipeline: CiPipeline | null = {
    id: "12",
    sha: "merge-sha",
    status: "failed",
    url: "https://git.example/pipelines/12",
    jobs: [{ id: "34", name: "test", status: "failed", url: null, allowFailure: false }],
  };
  let current = true;
  let match = 0;
  let posts = 0;
  let reads = 0;
  const commands: string[][] = [];
  let ambiguousPost = false;
  let localPushes = "";
  const api = {
    read: () =>
      Effect.sync(() => {
        reads++;
        return { current, pipeline };
      }),
    trace: () => Effect.succeed("test failed"),
    run: () =>
      Effect.gen(function* () {
        posts++;
        if (ambiguousPost)
          return yield* new SourceControlProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            cwd,
            operation: "ci",
            detail: "Response lost",
          });
      }),
  };
  const provider = yield* Provider.SourceControlProvider.pipe(
    Effect.provide(
      Layer.mock(Provider.SourceControlProvider)({
        kind: SourceControlProviderKind.make("gitlab"),
        ci: api,
      }),
    ),
  );
  const make = Monitor.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(cwd, cwd),
        Layer.mock(Providers.SourceControlProviderRegistry)({
          resolve: () => Effect.succeed(provider),
          resolveLink: () => undefined,
        }),
        Layer.mock(Process.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(match),
              stdout: "",
              stderr: match === 2 ? "classifier broke" : "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.mock(Git.GitVcsDriver)({
          resolvePushTarget: () =>
            Effect.succeed({
              remoteName: "fork",
              branchName: "remote-feature",
              viaPushRemote: true,
            }),
          execute: ({ args }) =>
            Effect.sync(() => {
              commands.push([...args]);
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout:
                  args[0] === "reflog"
                    ? localPushes
                    : args[0] === "for-each-ref"
                      ? "local\0origin\0refs/heads/published\0origin\0refs/heads/published\n"
                      : args[0] === "remote"
                        ? args[1] === "get-url"
                          ? "git@git.example:acme/app.git"
                          : "origin\nfork\n"
                        : args.includes("--git-common-dir")
                          ? `${cwd}/.git`
                          : "a".repeat(40),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
  const input = {
    cwd,
    host: "git.example",
    repository: "acme/app",
    branch: "feature",
    sha: "a".repeat(40),
    threadId: ThreadId.make("originating-thread"),
  };
  const snapshots = (service: Monitor.CiMonitor["Service"]) =>
    Stream.runHead(service.subscribe).pipe(Effect.map(Option.getOrThrow));
  return {
    cwd,
    fs,
    make,
    input,
    snapshots,
    pipeline: () => pipeline,
    setPipeline: (value: CiPipeline | null) => {
      pipeline = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
    setMatch: (value: number) => {
      match = value;
    },
    posts: () => posts,
    reads: () => reads,
    commands,
    setLocalPushes: (value: string) => {
      localPushes = value;
    },
    loseResponse: () => {
      ambiguousPost = true;
    },
  };
});
it.layer(NodeServices.layer)("background CI", (it) => {
  it.effect("does not repair cancelled, skipped, or manually gated pipelines", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      for (const [status, state] of [
        ["canceled", "cancelled"],
        ["skipped", "skipped"],
        ["manual", "waiting"],
      ] as const) {
        yield* service.register({ ...f.input, branch: status });
        f.setPipeline({ ...f.pipeline()!, status });
        yield* service.sweep;
        expect((yield* f.snapshots(service)).find((item) => item.branch === status)?.state).toBe(
          state,
        );
      }
      expect(f.posts()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "dismisses finished activities persistently without removing running work or retry budgets",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const service = yield* f.make;
        yield* service.register(f.input);
        const id = (yield* f.snapshots(service))[0]!.id;
        const error = yield* service.dismiss(id).pipe(Effect.flip);
        expect(error.detail).toBe("Running CI activities cannot be dismissed.");
        yield* service.sweep;
        expect(f.posts()).toBe(1);
        f.setMatch(1);
        yield* service.sweep;
        expect((yield* f.snapshots(service))[0]?.state).toBe("failed");
        yield* service.register({ ...f.input, branch: "still-running" });
        yield* service.dismiss(id);
        yield* service.dismiss(id);
        expect((yield* f.snapshots(service)).map((item) => item.branch)).toEqual(["still-running"]);
        const restarted = yield* f.make;
        yield* restarted.register(f.input);
        expect((yield* f.snapshots(restarted)).map((item) => item.branch)).toEqual([
          "still-running",
        ]);
        const stored = JSON.parse(
          yield* f.fs.readFileString(`${f.cwd}/userdata/ci-activities.json`),
        ) as Array<{ activity: CiActivity }>;
        expect(stored.find((item) => item.activity.id === id)?.activity.attempts.repair).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "discovers local pushes without treating fetches as pushes or using the current local HEAD",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const service = yield* f.make;
        const sha = "b".repeat(40);
        const input = {
          cwd: f.cwd,
          threads: [{ id: f.input.threadId, branch: "local", worktreePath: null }],
        };
        f.setLocalPushes(`refs/remotes/origin/published@{0}\0${sha}\0fetch origin: fast-forward\n`);
        yield* service.discoverLocalPushes(input);
        expect(yield* f.snapshots(service)).toEqual([]);
        yield* TestClock.adjust("20 seconds");
        f.setLocalPushes(`refs/remotes/origin/published@{0}\0${sha}\0update by push\n`);
        yield* service.withPublication(f.cwd, service.discoverLocalPushes(input));
        expect(yield* f.snapshots(service)).toEqual([]);
        yield* service.discoverLocalPushes(input);
        expect((yield* f.snapshots(service))[0]).toMatchObject({
          sha,
          branch: "published",
          localBranch: "local",
          threadId: f.input.threadId,
        });
        yield* service.discoverLocalPushes(input);
        expect((yield* f.snapshots(service)).length).toBe(1);
        yield* TestClock.adjust("20 seconds");
        f.setLocalPushes(`refs/remotes/origin/published@{0}\0${"c".repeat(40)}\0update by push\n`);
        yield* service.discoverLocalPushes({
          ...input,
          threads: [...input.threads, { ...input.threads[0]!, id: ThreadId.make("another") }],
        });
        expect((yield* f.snapshots(service))[0]?.threadId).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("tracks the push destination instead of the comparison upstream", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      yield* service.recordPush({ cwd: f.cwd, branch: "feature", threadId: f.input.threadId });
      const activity = (yield* f.snapshots(service))[0];
      expect(activity).toMatchObject({
        branch: "remote-feature",
        localBranch: "feature",
        host: "git.example",
        repository: "acme/app",
        sha: f.input.sha,
      });
      expect(f.commands).toContainEqual(["remote", "get-url", "--push", "fork"]);
      expect(f.reads()).toBe(0);
      yield* service.recordPush({
        cwd: f.cwd,
        branch: "feature",
        remoteName: "stack-remote",
        threadId: f.input.threadId,
      });
      expect(f.commands).toContainEqual(["remote", "get-url", "--push", "stack-remote"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "returns an unresolved failure to its originating thread only once across restarts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(
          `${f.cwd}/.t3code/ci.json`,
          '{"onUnresolvedFailure":{"action":"resume-originating-thread","instructions":"Diagnose this failure"}}',
        );
        const notified = yield* Deferred.make<void>();
        const deliveries: string[] = [];
        const wake = (activity: CiActivity) =>
          Effect.sync(() => {
            deliveries.push(activity.threadId!);
          }).pipe(Effect.andThen(Deferred.succeed(notified, undefined)), Effect.as(true));
        const service = yield* f.make;
        yield* service.register(f.input);
        yield* service.start(wake);
        yield* Deferred.await(notified);
        yield* service.sweep;
        const restarted = yield* f.make;
        yield* restarted.start(wake);
        yield* restarted.sweep;
        expect(deliveries).toEqual([f.input.threadId]);
      }).pipe(Effect.scoped),
  );
  it.effect("starts CI discovery after publication ends without taking a checkout lease", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      yield* service.withPublication(
        f.cwd,
        Effect.gen(function* () {
          yield* service.register(f.input);
          yield* service.sweep;
          expect(f.reads()).toBe(0);
        }),
      );
      yield* service.sweep;
      expect(f.reads()).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("retains a consumed allowance when a recovery POST response is lost", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      f.loseResponse();
      yield* service.register(f.input);
      yield* service.sweep;
      expect((yield* f.snapshots(service))[0]?.attempts.repair).toBe(1);
      const restarted = yield* f.make;
      yield* restarted.sweep;
      expect(f.posts()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("persists retry allowances across restart and waits for actual pipeline success", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.make;
      yield* first.register(f.input);
      expect(f.reads()).toBe(0);
      yield* first.sweep;
      expect(f.posts()).toBe(1);
      expect((yield* f.snapshots(first))[0]?.state).toBe("recovering");
      const restarted = yield* f.make;
      yield* restarted.register(f.input);
      yield* restarted.sweep;
      expect(f.posts()).toBe(1);
      expect((yield* f.snapshots(restarted))[0]?.state).toBe("failed");
      const nextInput = { ...f.input, sha: "b".repeat(40) };
      yield* restarted.register(nextInput);
      f.setPipeline({
        ...f.pipeline()!,
        status: "running",
        jobs: [{ ...f.pipeline()!.jobs[0]!, status: "running" }],
      });
      yield* restarted.sweep;
      expect((yield* f.snapshots(restarted))[0]?.state).toBe("running");
      f.setPipeline({
        ...f.pipeline()!,
        status: "success",
        jobs: [{ ...f.pipeline()!.jobs[0]!, status: "success" }],
      });
      yield* restarted.sweep;
      expect((yield* f.snapshots(restarted)).some((item) => item.sha === nextInput.sha)).toBe(
        false,
      );
      const afterSuccess = yield* f.make;
      expect((yield* f.snapshots(afterSuccess)).some((item) => item.sha === nextInput.sha)).toBe(
        false,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("supersedes older pushes and refuses recovery for a remotely changed head", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      yield* service.register(f.input);
      yield* service.register({ ...f.input, sha: "b".repeat(40) });
      expect((yield* f.snapshots(service)).find((item) => item.sha === f.input.sha)?.state).toBe(
        "superseded",
      );
      f.setCurrent(false);
      yield* service.sweep;
      expect(f.posts()).toBe(0);
      expect((yield* f.snapshots(service)).every((item) => item.state === "superseded")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports classifier errors and never retries unclassified failures", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      for (const exit of [1, 2]) {
        f.setMatch(exit);
        yield* service.register({ ...f.input, sha: String(exit).repeat(40) });
        yield* service.sweep;
        const activity = (yield* f.snapshots(service)).find(
          (item) => item.sha === String(exit).repeat(40),
        );
        expect(activity?.state).toBe("failed");
        if (exit === 2) expect(activity?.label).toContain("classifier broke");
      }
      expect(f.posts()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps tracking without a pipeline and accepts configured manual reset jobs", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        `${f.cwd}/.t3code/ci.json`,
        '{"recovery":{"reset":{"jobs":["test"],"match":["classify"],"action":{"type":"play-job","name":"reset:stack"},"maxAttempts":1}}}',
      );
      const service = yield* f.make;
      f.setPipeline(null);
      yield* service.register(f.input);
      yield* service.sweep;
      expect((yield* f.snapshots(service))[0]?.state).toBe("waiting");
      f.setPipeline({
        id: "12",
        sha: "merge",
        status: "failed",
        url: "https://git.example/pipelines/12",
        jobs: [
          { id: "34", name: "test", status: "failed", url: null, allowFailure: false },
          { id: "35", name: "reset:stack", status: "manual", url: null, allowFailure: true },
        ],
      });
      yield* service.sweep;
      expect(f.posts()).toBe(1);
      f.setPipeline({
        ...f.pipeline()!,
        jobs: f
          .pipeline()!
          .jobs.map((job) => (job.name === "reset:stack" ? { ...job, status: "running" } : job)),
      });
      yield* service.sweep;
      expect((yield* f.snapshots(service))[0]?.state).toBe("recovering");
      expect(f.posts()).toBe(1);
    }).pipe(Effect.scoped),
  );
});

it.live("reads actual push reflogs after a checkout switch and ignores a fetched branch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-push-" });
    const cwd = `${directory}/checkout`;
    const bare = `${directory}/remote.git`;
    const host = yield* SourceControlHost.SourceControlHost;
    const run = (...args: string[]) =>
      host.process
        .run({ operation: "test", command: "git", cwd: directory, args })
        .pipe(Effect.map((result) => result.stdout));
    yield* run("init", "--bare", bare);
    yield* run("init", "-b", "main", cwd);
    const git = (...args: string[]) => run("-C", cwd, ...args);
    yield* git("config", "user.name", "CI discovery test");
    yield* git("config", "user.email", "ci@example.test");
    yield* git("config", "core.logAllRefUpdates", "true");
    yield* git("commit", "--allow-empty", "-m", "base");
    yield* git("switch", "-c", "local");
    yield* git("remote", "add", "origin", "https://git.example/acme/app.git");
    yield* fs.makeDirectory(`${cwd}/.t3code`);
    yield* fs.writeFileString(`${cwd}/.t3code/ci.json`, "{}");
    const service = yield* Monitor.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(cwd, directory),
          Layer.mock(Providers.SourceControlProviderRegistry)({ resolveLink: () => undefined }),
          Layer.mock(Process.VcsProcess)({}),
          Layer.mock(Git.GitVcsDriver)({ execute: (input) => host.git.execute(input) }),
        ),
      ),
    );
    // Only these commands override the fixture URL; discovery sees a normal forge remote.
    yield* git("-c", `remote.origin.pushurl=${bare}`, "push", "-u", "origin", "local:published");
    const sha = (yield* git("rev-parse", "HEAD")).trim();
    yield* run("--git-dir", bare, "update-ref", "refs/heads/fetched", sha);
    yield* git("fetch", bare, "+refs/heads/*:refs/remotes/origin/*");
    yield* git("commit", "--allow-empty", "-m", "not pushed");
    yield* git("switch", "main");
    const threadId = ThreadId.make("external-push-thread");
    yield* service.discoverLocalPushes({
      cwd,
      threads: [{ id: threadId, branch: "local", worktreePath: null }],
    });
    const activities = Option.getOrThrow(yield* Stream.runHead(service.subscribe));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      sha,
      branch: "published",
      localBranch: "local",
      threadId,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestSourceControlHost.layerWithRealGit())),
  ),
);
