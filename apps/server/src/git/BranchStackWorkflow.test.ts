import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitManagerError, type GitWorkflowProgressUpdate } from "@t3tools/contracts";
import { make } from "./BranchStackWorkflow.ts";

const decodeSavedStacks = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        remote: Schema.String,
        layers: Schema.Array(
          Schema.Struct({
            branch: Schema.String,
            remoteHead: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  ),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stack-test-" });
  const cwd = path.join(root, "repo");
  yield* fs.makeDirectory(cwd);
  const git = Effect.fn("fixture.git")(function* (args: ReadonlyArray<string>) {
    return (yield* process.run({
      operation: "test.stack",
      command: "git",
      args,
      cwd,
    })).stdout.trim();
  });
  for (const remote of ["origin", "fork"]) {
    yield* git(["init", "--bare", path.join(root, remote)]);
  }
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "commit.gpgsign", "false"]);
  yield* git(["config", "core.autocrlf", "false"]);
  const commit = Effect.fn("fixture.commit")(function* (file: string, content: string) {
    yield* fs.writeFileString(path.join(cwd, file), content);
    yield* git(["add", file]);
    yield* git(["commit", "-m", `Change ${file}`]);
    return yield* git(["rev-parse", "HEAD"]);
  });
  yield* commit("shared.txt", "base\n");
  for (const branch of ["a", "b", "c"]) {
    yield* git(["checkout", "-b", branch]);
    yield* commit(`${branch}.txt`, `${branch}\n`);
  }
  for (const remote of ["origin", "fork"]) {
    yield* git(["remote", "add", remote, path.join(root, remote)]);
    yield* git(["push", remote, "main", "a", "b", "c"]);
  }
  yield* git(["config", "remote.pushDefault", "fork"]);
  yield* git(["checkout", "b"]);
  const stacks = yield* make;
  const adopt = stacks.manage({ cwd, action: "adopt", base: "main", branches: ["a", "b", "c"] });
  const remoteHead = (remote: string, branch: string) =>
    git([`--git-dir=${path.join(root, remote)}`, "rev-parse", `refs/heads/${branch}`]);
  return { fs, path, root, cwd, git, commit, stacks, adopt, remoteHead };
});

it.layer(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))("branch stacks", (it) => {
  it.effect(
    "keeps untracked branches opted out of automatic tracking until explicitly adopted again",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        yield* f.stacks.manage({ cwd: f.cwd, action: "untrack" });
        expect(yield* f.stacks.canAutoTrack(f.cwd, ["a", "b", "c"])).toBe(false);
        yield* f.adopt;
        expect(yield* f.stacks.canAutoTrack(f.cwd, ["a", "b", "c"])).toBe(true);
        yield* f.git(["checkout", "c"]);
        yield* f.stacks.manage({ cwd: f.cwd, action: "edit", base: "main", branches: ["a", "c"] });
        expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "c",
        ]);
        expect(yield* f.stacks.canAutoTrack(f.cwd, ["b"])).toBe(false);
      }).pipe(Effect.scoped),
  );
  it.effect("splits the current layer at commit boundaries without moving any existing refs", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.git(["rev-parse", "b"]);
      const second = yield* f.commit("second.txt", "second\n");
      const tip = yield* f.commit("third.txt", "third\n");
      yield* f.git(["rebase", "--onto", "b", first, "c"]);
      yield* f.git(["checkout", "b"]);
      yield* f.adopt;
      const oldRefs = yield* f.git(["show-ref"]);
      const upperHead = yield* f.git(["rev-parse", "c"]);
      yield* f.fs.writeFileString(f.path.join(f.cwd, "dirty.txt"), "uncommitted\n");
      const contexts: string[][] = [];
      const result = yield* f.stacks.manage(
        {
          cwd: f.cwd,
          action: "edit",
          branches: ["a", "b", "c"],
          base: "main",
          expectedBranch: "b",
          expectedHeadSha: tip,
          splitPoints: [first, second],
        },
        [],
        undefined,
        undefined,
        (base, end) =>
          Effect.sync(() => {
            contexts.push([base, end]);
            return `part-${contexts.length}`;
          }),
      );
      expect(contexts).toEqual([
        [yield* f.git(["rev-parse", "a"]), first],
        [first, second],
      ]);
      expect(result.layers.map((layer) => [layer.branch, layer.parent])).toEqual([
        ["a", "main"],
        ["part-1", "a"],
        ["part-2", "part-1"],
        ["b", "part-2"],
        ["c", "b"],
      ]);
      expect(yield* f.git(["rev-parse", "part-1"])).toBe(first);
      expect(yield* f.git(["rev-parse", "part-2"])).toBe(second);
      expect(yield* f.git(["rev-parse", "b"])).toBe(tip);
      expect(yield* f.git(["rev-parse", "c"])).toBe(upperHead);
      expect(yield* f.git(["branch", "--show-current"])).toBe("b");
      expect(
        (yield* f.git(["show-ref"]))
          .split("\n")
          .filter((line) => !line.includes("refs/heads/part-"))
          .join("\n"),
      ).toBe(oldRefs);
      expect(yield* f.fs.readFileString(f.path.join(f.cwd, "dirty.txt"))).toBe("uncommitted\n");
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    "parent",
    "tip",
    "duplicate",
    "stale",
    "generation-failed",
    "save-failed",
    "moved-during-generation",
  ] as const)("rejects unsafe layer splits without creating refs: %s", (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.git(["checkout", "c"]);
      const first = yield* f.git(["rev-parse", "HEAD"]);
      const tip = yield* f.commit("next.txt", "next\n");
      yield* f.adopt;
      const refs = yield* f.git(["show-ref"]);
      const saved = yield* f.fs.readFileString(f.path.join(f.cwd, ".git/t3-branch-stacks.json"));
      if (mode === "save-failed")
        yield* f.fs.makeDirectory(f.path.join(f.cwd, ".git/t3-branch-stacks.json.tmp"));
      const result = yield* f.stacks
        .manage(
          {
            cwd: f.cwd,
            action: "edit",
            expectedBranch: "c",
            expectedHeadSha: mode === "stale" ? first : tip,
            splitPoints:
              mode === "parent"
                ? [yield* f.git(["rev-parse", "b"])]
                : mode === "tip"
                  ? [tip]
                  : mode === "duplicate"
                    ? [first, first]
                    : [first],
          },
          [],
          undefined,
          undefined,
          () =>
            Effect.gen(function* () {
              if (mode === "generation-failed")
                return yield* new GitManagerError({
                  cwd: f.cwd,
                  operation: "test",
                  detail: "Generation failed",
                });
              if (mode === "moved-during-generation")
                yield* f
                  .git(["commit", "--allow-empty", "-m", "External change"])
                  .pipe(Effect.orDie);
              return "split-layer";
            }),
        )
        .pipe(Effect.flip);
      expect(result).toBeInstanceOf(GitManagerError);
      expect(yield* f.fs.readFileString(f.path.join(f.cwd, ".git/t3-branch-stacks.json"))).toBe(
        saved,
      );
      if (mode !== "moved-during-generation") expect(yield* f.git(["show-ref"])).toBe(refs);
      expect(yield* f.git(["branch", "--list", "split-layer"])).toBe("");
    }).pipe(Effect.scoped),
  );
  it.effect.each(["new", "legacy", "legacy-linked", "abort"] as const)(
    "keeps independent worktree recovery journals separate: %s",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const process = yield* VcsProcess.VcsProcess;
        const other = f.path.join(f.root, "independent");
        yield* f.git(["worktree", "add", "-b", "independent", other, "main"]);
        const otherGit = (args: readonly string[]) =>
          process.run({ command: "git", operation: "test.stack", cwd: other, args });
        yield* f.fs.writeFileString(f.path.join(other, "independent.txt"), "independent\n");
        yield* otherGit(["add", "."]);
        yield* otherGit(["commit", "-m", "Independent change"]);
        yield* f.adopt;
        yield* f.commit("first-update.txt", "first update\n");
        const stop = () =>
          Effect.fail(
            new GitManagerError({ cwd: f.cwd, operation: "test", detail: "Hooks stopped" }),
          );
        yield* f.stacks.update(f.cwd, { publishThrough: "b", afterPush: stop }).pipe(Effect.flip);
        expect((yield* f.stacks.inspect(other)).operation).toBeNull();
        expect((yield* f.stacks.inspect(other)).layers.map((layer) => layer.branch)).toEqual([
          "independent",
        ]);
        if (mode === "legacy")
          yield* f.fs.rename(
            f.path.join(f.cwd, ".git/t3-stack-operations/root.json"),
            f.path.join(f.cwd, ".git/t3-stack-operation.json"),
          );
        const resumed = yield* make;
        yield* resumed.manage({
          cwd: other,
          action: "adopt",
          base: "main",
          branches: ["independent"],
        });
        yield* resumed
          .update(other, { publishThrough: "independent", afterPush: stop })
          .pipe(Effect.flip);
        if (mode === "legacy-linked") {
          const admin = (yield* otherGit(["rev-parse", "--absolute-git-dir"])).stdout.trim();
          yield* f.fs.rename(
            f.path.join(f.cwd, `.git/t3-stack-operations/worktree-${f.path.basename(admin)}.json`),
            f.path.join(f.cwd, ".git/t3-stack-operation.json"),
          );
        }
        expect((yield* resumed.inspect(f.cwd)).operation?.branch).toBe("b");
        expect((yield* resumed.inspect(other)).operation?.branch).toBe("independent");
        yield* resumed.manage(
          { cwd: f.cwd, action: mode === "abort" ? "abort" : "continue" },
          [],
          () => Effect.void,
        );
        expect((yield* resumed.inspect(f.cwd)).operation).toBeNull();
        expect((yield* resumed.inspect(other)).operation?.branch).toBe("independent");
        if (mode === "legacy-linked")
          expect(yield* f.fs.exists(f.path.join(f.cwd, ".git/t3-stack-operation.json"))).toBe(true);
        yield* resumed.manage({ cwd: other, action: "continue" }, [], () => Effect.void);
        expect((yield* resumed.inspect(other)).operation).toBeNull();
        expect((yield* resumed.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "b",
          "c",
        ]);
        expect(yield* f.fs.exists(f.path.join(f.cwd, ".git/t3-stack-operation.json"))).toBe(false);
      }).pipe(Effect.scoped),
  );
  it.effect("protects overlapping branches while a different worktree owns recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const other = f.path.join(f.root, "lower");
      yield* f.git(["worktree", "add", other, "a"]);
      yield* f.adopt;
      yield* f.commit("overlap.txt", "overlap\n");
      yield* f.stacks
        .update(f.cwd, {
          publishThrough: "b",
          afterPush: () =>
            Effect.fail(new GitManagerError({ cwd: f.cwd, operation: "test", detail: "Stopped" })),
        })
        .pipe(Effect.flip);
      const before = yield* f.git(["show-ref"]);
      const failure = yield* f.stacks.update(other).pipe(Effect.flip);
      expect(failure.message).toContain(f.cwd);
      expect(yield* f.git(["show-ref"])).toBe(before);
      expect((yield* f.stacks.inspect(other)).operation?.cwd).toBe(f.cwd);
      yield* f.stacks.manage({ cwd: f.cwd, action: "abort" });
      expect((yield* f.stacks.inspect(other)).operation).toBeNull();
    }).pipe(Effect.scoped),
  );
  it.effect(
    "allows independent operations to run concurrently without losing shared stack metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const process = yield* VcsProcess.VcsProcess;
        const other = f.path.join(f.root, "parallel");
        yield* f.git(["worktree", "add", "-b", "parallel", other, "main"]);
        const otherGit = (args: readonly string[]) =>
          process.run({ command: "git", operation: "test.stack", cwd: other, args });
        yield* f.fs.writeFileString(f.path.join(other, "parallel.txt"), "parallel\n");
        yield* otherGit(["add", "."]);
        yield* otherGit(["commit", "-m", "Parallel change"]);
        yield* f.adopt;
        yield* f.stacks.manage({
          cwd: other,
          action: "adopt",
          base: "main",
          branches: ["parallel"],
        });
        yield* f.commit("concurrent.txt", "concurrent\n");
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const first = yield* f.stacks
          .update(f.cwd, {
            publishThrough: "b",
            afterPush: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.raceFirst(Fiber.join(first)));
        yield* f.stacks.update(other);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(first);
        expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "b",
          "c",
        ]);
        expect((yield* f.stacks.inspect(other)).layers.map((layer) => layer.branch)).toEqual([
          "parallel",
        ]);
        expect((yield* f.stacks.inspect(other)).managed).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("updates the stack locally without publishing or running post-push hooks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const remoteHeads = yield* f.git(["ls-remote", "fork"]);
      yield* f.commit("local.txt", "local change\n");
      const hooks: string[] = [];
      const updates: GitWorkflowProgressUpdate[] = [];
      const update = yield* f.stacks.manage(
        { cwd: f.cwd, action: "update" },
        [],
        (_cwd, branch) =>
          Effect.sync(() => {
            hooks.push(branch);
          }),
        (progress) =>
          Effect.sync(() => {
            updates.push(progress);
          }),
      );
      expect(updates.length).toBeGreaterThan(0);
      for (const progress of updates) {
        expect(progress.steps.map((step) => step.id)).toEqual(["a:rebase", "b:rebase", "c:rebase"]);
      }
      expect(yield* f.git(["show", "c:local.txt"])).toBe("local change");
      expect(yield* f.git(["branch", "--show-current"])).toBe("b");
      expect(yield* f.git(["ls-remote", "fork"])).toBe(remoteHeads);
      expect(hooks).toEqual([]);
      expect(update.operation).toBeNull();
      yield* f.stacks.update(f.cwd, { publishThrough: "c" });
      expect(yield* f.remoteHead("fork", "c")).toBe(yield* f.git(["rev-parse", "c"]));
    }).pipe(Effect.scoped),
  );
  it.effect("keeps the publication boundary when continuing unfinished hooks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const oldC = yield* f.remoteHead("fork", "c");
      yield* f.commit("boundary.txt", "middle change\n");
      yield* f.stacks
        .update(f.cwd, {
          publishThrough: "b",
          afterPush: () =>
            Effect.fail(
              new GitManagerError({ operation: "test", cwd: f.cwd, detail: "Hook stopped" }),
            ),
        })
        .pipe(Effect.flip);
      expect((yield* f.stacks.inspect(f.cwd)).operation?.publishThrough).toBe("b");
      const retried: string[] = [];
      const updates: GitWorkflowProgressUpdate[] = [];
      yield* f.stacks.manage(
        { cwd: f.cwd, action: "continue" },
        [],
        (_cwd, branch) =>
          Effect.sync(() => {
            retried.push(branch);
          }),
        (update) =>
          Effect.sync(() => {
            updates.push(update);
          }),
      );
      expect(updates[0]?.steps.find((step) => step.id === "b:rebase")?.state).toBe("skipped");
      expect(updates[0]?.steps.find((step) => step.id === "c:rebase")?.state).toBe("completed");
      expect(retried).toEqual(["b"]);
      expect(yield* f.remoteHead("fork", "c")).toBe(oldC);
      expect(yield* f.git(["rev-parse", "c"])).not.toBe(oldC);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "publishes only through the selected layer while restacking upper branches locally",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const oldC = yield* f.remoteHead("fork", "c");
        yield* f.commit("review.txt", "middle update\n");
        const hooks: string[] = [];
        yield* f.stacks.update(f.cwd, {
          publishThrough: "b",
          afterPush: (_cwd, branch) =>
            Effect.sync(() => {
              hooks.push(branch);
            }),
        });
        expect(hooks).toEqual(["b"]);
        expect(yield* f.remoteHead("fork", "b")).toBe(yield* f.git(["rev-parse", "b"]));
        expect(yield* f.remoteHead("fork", "c")).toBe(oldC);
        expect(yield* f.git(["rev-parse", "c"])).not.toBe(oldC);
        expect(yield* f.git(["show", "c:review.txt"])).toBe("middle update");
        yield* f.git(["checkout", "c"]);
        yield* f.stacks.update(f.cwd, { publishThrough: "c" });
        expect(yield* f.remoteHead("fork", "c")).toBe(yield* f.git(["rev-parse", "c"]));
      }).pipe(Effect.scoped),
  );
  it.effect.each(["unchanged", "externally-restacked", "merged-parent-rewrite"] as const)(
    "leaves an up-to-date child in its worktree while publishing: %s",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        if (mode === "externally-restacked") {
          const oldB = yield* f.git(["rev-parse", "b"]);
          yield* f.commit("parent.txt", "parent change\n");
          yield* f.git(["rebase", "--onto", "b", oldB, "c"]);
          yield* f.git(["checkout", "b"]);
        } else if (mode === "merged-parent-rewrite") {
          yield* f.git(["commit", "--amend", "-m", "Rewrite parent"]);
          yield* f.git(["checkout", "c"]);
          yield* f.git(["merge", "b", "--no-edit"]);
          yield* f.git(["checkout", "b"]);
        }
        const child = yield* f.git(["rev-parse", "c"]);
        expect((yield* f.stacks.inspect(f.cwd)).layers[2]).toMatchObject({
          behindCount: 0,
          needsRestack: false,
        });
        yield* f.git(["worktree", "add", f.path.join(f.root, "child"), "c"]);
        const progress: GitWorkflowProgressUpdate[] = [];
        yield* f.stacks.update(f.cwd, {
          publishThrough: "b",
          onProgress: (update) =>
            Effect.sync(() => {
              progress.push(update);
            }),
        });
        expect(yield* f.git(["rev-parse", "c"])).toBe(child);
        expect(
          progress
            .at(-1)
            ?.steps.filter((step) => step.id.endsWith(":rebase"))
            .every((step) => step.state === "skipped"),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );
  it.effect.each([
    "base",
    "base-local",
    "middle",
    "partial-base",
    "rewritten-parent",
    "rewound-parent",
    "missing-boundary",
  ] as const)("refreshes stale boundaries after an external rebase: %s", (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const parent =
        mode === "middle" ||
        mode === "rewritten-parent" ||
        mode === "rewound-parent" ||
        mode === "missing-boundary"
          ? "b"
          : "main";
      const branch = parent === "b" ? "c" : "a";
      const previousParent = yield* f.git(["rev-parse", parent]);
      yield* f.git(["checkout", parent]);
      if (mode === "missing-boundary") {
        yield* f.git(["rebase", "--onto", "main", "b", "c"]);
        const before = yield* f.git(["show-ref", "--heads"]);
        const error = yield* f.stacks.update(f.cwd).pipe(Effect.flip);
        expect(error.message).toContain("no longer matches its history");
        expect(yield* f.git(["show-ref", "--heads"])).toBe(before);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
        return;
      }
      if (mode === "rewound-parent") {
        yield* f.git(["reset", "--hard", "a"]);
        yield* f.git(["push", "--force", "fork", "b"]);
        yield* f.git(["checkout", branch]);
      } else if (mode === "rewritten-parent") {
        yield* f.git(["commit", "--amend", "-m", "Rewrite parent"]);
        yield* f.git(["checkout", branch]);
      } else {
        const intermediate = yield* f.commit("shared.txt", "upstream one\n");
        yield* f.commit("shared.txt", "upstream two\n");
        if (parent === "main") yield* f.git(["push", "origin", "main"]);
        yield* f.git([
          "rebase",
          "--onto",
          mode === "partial-base" ? intermediate : parent,
          previousParent,
          branch,
        ]);
      }
      const externallyRebased = yield* f.git(["rev-parse", branch]);
      if (mode === "rewound-parent")
        expect((yield* f.stacks.inspect(f.cwd)).layers[2]).toMatchObject({
          behindCount: 0,
          needsRestack: true,
        });
      const result = yield* f.stacks.update(f.cwd, { includeLatestBase: mode !== "base-local" });
      expect(result.operation).toBeNull();
      expect(result.layers.every((layer) => !layer.needsRestack)).toBe(true);
      if (mode !== "partial-base" && mode !== "rewritten-parent" && mode !== "rewound-parent")
        expect(yield* f.git(["rev-parse", branch])).toBe(externallyRebased);
      for (const [index, name] of ["a", "b", "c"].entries()) {
        expect(
          yield* f.git([
            "rev-list",
            "--count",
            `${index === 0 ? "main" : ["a", "b"][index - 1]}..${name}`,
          ]),
        ).toBe(
          mode === "middle" && name === "b"
            ? "3"
            : mode === "rewound-parent" && name === "b"
              ? "0"
              : "1",
        );
      }
      expect(yield* f.git(["show", "c:shared.txt"])).toBe(
        mode === "rewritten-parent" || mode === "rewound-parent" ? "base" : "upstream two",
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["prepend", "insert", "append", "overlap", "subset", "base-change"] as const)(
    "adopting a detected hierarchy extends only one complete existing stack: %s",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const tracked =
          mode === "prepend" || mode === "base-change"
            ? ["c"]
            : mode === "insert"
              ? ["a", "c"]
              : mode === "subset"
                ? ["a", "b", "c"]
                : ["a", "b"];
        yield* f.git(["checkout", tracked[0]!]);
        yield* f.stacks.manage({ cwd: f.cwd, action: "adopt", base: "main", branches: tracked });
        if (mode === "insert") yield* f.git(["config", "branch.c.t3-merge-base", "a"]);
        if (mode === "overlap") {
          yield* f.git(["checkout", "c"]);
          yield* f.stacks.manage({ cwd: f.cwd, action: "adopt", base: "main", branches: ["c"] });
        }
        const statePath = f.path.join(f.cwd, ".git", "t3-branch-stacks.json");
        const before = yield* f.fs.readFileString(statePath);
        const originalRefs = yield* f.git(["show-ref", "--heads"]);
        const originalLease = yield* f.remoteHead("fork", tracked[0]!);
        yield* f.git(["config", "remote.pushDefault", "origin"]);
        yield* f.git([
          `--git-dir=${f.path.join(f.root, "fork")}`,
          "update-ref",
          `refs/heads/${tracked[0]}`,
          yield* f.git(["rev-parse", "c"]),
        ]);
        yield* f.git(["checkout", mode === "append" ? "c" : mode === "prepend" ? "a" : "b"]);
        if (mode === "base-change") yield* f.git(["branch", "base-alias", "main"]);
        if (mode === "prepend" || mode === "insert" || mode === "append") {
          for (const branch of ["a", "b", "c"]) {
            yield* f.git(["checkout", branch]);
            const detected = yield* f.stacks.inspect(f.cwd);
            expect(detected.layers.map((layer) => layer.branch)).toEqual(["a", "b", "c"]);
            expect(detected.layers.map((layer) => layer.parent)).toEqual(["main", "a", "b"]);
            expect(yield* f.fs.readFileString(statePath)).toBe(before);
          }
          yield* f.git(["checkout", mode === "append" ? "c" : mode === "prepend" ? "a" : "b"]);
        }
        const operation = f.stacks.manage({
          cwd: f.cwd,
          action: "adopt",
          base: mode === "base-change" ? "base-alias" : "main",
          branches: mode === "subset" ? ["a", "b"] : ["a", "b", "c"],
        });
        if (mode === "overlap" || mode === "subset" || mode === "base-change") {
          const error = yield* operation.pipe(Effect.flip);
          expect(error.message).toContain("already managed in another stack");
          expect(yield* f.fs.readFileString(statePath)).toBe(before);
        } else {
          const result = yield* operation;
          expect(result.managed).toBe(true);
          expect(result.remote).toBe("fork");
          expect(result.layers.map((layer) => layer.branch)).toEqual(["a", "b", "c"]);
          const saved = decodeSavedStacks(yield* f.fs.readFileString(statePath));
          expect(saved).toHaveLength(1);
          expect(saved[0]?.layers.find((layer) => layer.branch === tracked[0])?.remoteHead).toBe(
            originalLease,
          );
        }
        if (mode !== "base-change")
          expect(yield* f.git(["show-ref", "--heads"])).toBe(originalRefs);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "edits an adopted hierarchy without rewriting branches and preserves it on invalid edits",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const original = yield* f.git(["show-ref", "--heads"]);
        yield* f.git(["branch", "inserted", "a"]);
        const edited = yield* f.stacks.manage({
          cwd: f.cwd,
          action: "edit",
          base: "main",
          branches: ["a", "inserted", "b", "c"],
        });
        expect(edited.layers.map((layer) => layer.branch)).toEqual(["a", "inserted", "b", "c"]);
        expect(edited.baseIsDefault).toBe(true);
        yield* f.stacks
          .manage({ cwd: f.cwd, action: "edit", base: "main", branches: ["c", "b"] })
          .pipe(Effect.flip);
        expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "inserted",
          "b",
          "c",
        ]);
        const trimmed = yield* f.stacks.manage({
          cwd: f.cwd,
          action: "edit",
          base: "a",
          branches: ["b", "c"],
        });
        expect(trimmed.baseIsDefault).toBe(false);
        expect(trimmed.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
        expect(yield* f.stacks.canAutoTrack(f.cwd, ["a"])).toBe(false);
        yield* f.git(["branch", "-D", "inserted"]);
        expect(yield* f.git(["show-ref", "--heads"])).toBe(original);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "restacks a descendant with multiple commits, publishes only to the configured fork, and returns to the edited layer",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const oldA = yield* f.git(["rev-parse", "a"]);
        const oldC = yield* f.git(["rev-parse", "c"]);
        const status = yield* f.adopt;
        expect(status.remote).toBe("fork");
        expect(status.layers.every((layer) => layer.behindCount === 0)).toBe(true);
        yield* f.commit("b.txt", "updated\n");
        expect((yield* f.stacks.inspect(f.cwd)).layers[2]).toMatchObject({
          needsRestack: true,
          behindCount: 1,
        });
        const newB = yield* f.commit("b-extra.txt", "another logical commit\n");
        expect((yield* f.stacks.inspect(f.cwd)).layers[2]).toMatchObject({
          needsRestack: true,
          behindCount: 2,
        });
        const updates: GitWorkflowProgressUpdate[] = [];
        yield* f.stacks.update(f.cwd, {
          publishThrough: "c",
          onProgress: (update) =>
            Effect.sync(() => {
              updates.push(update);
            }),
        });
        const hooks = updates.find((update) =>
          update.steps.some((step) => step.id === "c:hooks" && step.state === "running"),
        );
        expect(
          hooks?.steps
            .filter((step) => step.id.endsWith(":push"))
            .every((step) => step.state === "completed" || step.state === "skipped"),
        ).toBe(true);
        expect(updates.at(-1)?.steps.find((step) => step.id === "a:hooks")?.state).toBe("skipped");
        expect(yield* f.git(["branch", "--show-current"])).toBe("b");
        expect(yield* f.git(["rev-parse", "a"])).toBe(oldA);
        expect(yield* f.git(["rev-parse", "b"])).toBe(newB);
        expect(yield* f.git(["show", "c:b-extra.txt"])).toBe("another logical commit");
        expect(yield* f.remoteHead("origin", "c")).toBe(oldC);
        expect(yield* f.remoteHead("fork", "c")).toBe(yield* f.git(["rev-parse", "c"]));
        const updatedStatus = yield* f.stacks.inspect(f.cwd);
        expect(updatedStatus.operation).toBeNull();
        expect(
          updatedStatus.layers.every((layer) => !layer.needsRestack && layer.behindCount === 0),
        ).toBe(true);
        yield* f.git(["checkout", "c"]);
        const top = yield* f.commit("top-extra.txt", "top fix\n");
        yield* f.stacks.pushCurrent(f.cwd, "c");
        expect(yield* f.remoteHead("fork", "c")).toBe(top);
        expect(yield* f.remoteHead("origin", "c")).toBe(oldC);
        expect(yield* f.git(["rev-parse", "b"])).toBe(newB);
      }).pipe(Effect.scoped),
  );
  it.effect.each([
    "abort",
    "continue",
    "external",
    "external-amend",
    "external-apply",
    "external-reset",
    "external-reset-after-finish",
    "external-wrong-parent",
    "external-dirty",
    "external-parent-moved",
  ] as const)("keeps conflict recovery durable and supports %s", (action) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.git(["checkout", "c"]);
      yield* f.commit("shared.txt", "top change\n");
      yield* f.git(["push", "fork", "c"]);
      yield* f.git(["checkout", "b"]);
      yield* f.adopt;
      const oldC = yield* f.git(["rev-parse", "c"]);
      const oldB = yield* f.remoteHead("fork", "b");
      yield* f.commit("shared.txt", "middle change\n");
      if (action === "external-apply") yield* f.git(["config", "rebase.backend", "apply"]);
      const failure = yield* f.stacks.update(f.cwd).pipe(Effect.flip);
      expect(failure.message).toContain("stopped at c");
      const resumed = yield* make;
      expect((yield* resumed.inspect(f.cwd)).operation?.branch).toBe("c");
      if (action === "external-reset" || action === "external-wrong-parent") {
        yield* f.git(["rebase", "--abort"]);
        if (action === "external-reset") yield* f.git(["reset", "--hard", "b"]);
        else yield* f.git(["rebase", "--onto", "a", oldB, "c"]);
      } else if (action !== "abort") {
        yield* f.fs.writeFileString(f.path.join(f.cwd, "shared.txt"), "both changes\n");
        yield* f.git(["add", "shared.txt"]);
        if (action.startsWith("external"))
          yield* f.git(["-c", "core.editor=true", "rebase", "--continue"]);
        if (action === "external-amend")
          yield* f.git(["commit", "--amend", "-m", "Amended resolution"]);
        if (action === "external-reset-after-finish") yield* f.git(["reset", "--hard", "b"]);
        if (action === "external-dirty")
          yield* f.fs.writeFileString(f.path.join(f.cwd, "dirty.txt"), "dirty\n");
        if (action === "external-parent-moved") {
          yield* f.git(["checkout", "b"]);
          yield* f.commit("parent-extra.txt", "parent moved\n");
          yield* f.git(["checkout", "c"]);
        }
      }
      const currentC = yield* f.git(["rev-parse", "c"]);
      const journalPath = f.path.join(f.cwd, ".git", "t3-stack-operations", "root.json");
      const beforeJournal = yield* f.fs.readFileString(journalPath);
      const operation = resumed.manage({
        cwd: f.cwd,
        action: action === "abort" ? "abort" : "continue",
      });
      if (
        [
          "external-reset",
          "external-wrong-parent",
          "external-reset-after-finish",
          "external-dirty",
          "external-parent-moved",
        ].includes(action)
      ) {
        yield* operation.pipe(Effect.flip);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        expect(yield* f.git(["rev-parse", "c"])).toBe(currentC);
        expect((yield* resumed.inspect(f.cwd)).operation?.branch).toBe("c");
        return;
      }
      yield* operation;
      if (action.startsWith("external")) expect(yield* f.git(["rev-parse", "c"])).toBe(currentC);
      expect(yield* f.git(["branch", "--show-current"])).toBe("b");
      expect((yield* resumed.inspect(f.cwd)).operation).toBeNull();
      expect(yield* f.remoteHead("fork", "b")).toBe(oldB);
      expect(yield* f.remoteHead("fork", "c")).toBe(oldC);
      if (action === "abort") expect(yield* f.git(["rev-parse", "c"])).toBe(oldC);
      else expect(yield* f.git(["show", "c:shared.txt"])).toBe("both changes");
    }).pipe(Effect.scoped),
  );
  it.effect("continues descendant layers after the base rebase finishes externally", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const remoteBefore = yield* f.git(["ls-remote", "fork"]);
      const oldC = yield* f.git(["rev-parse", "c"]);
      yield* f.git(["checkout", "a"]);
      yield* f.commit("shared.txt", "layer change\n");
      yield* f.git(["checkout", "main"]);
      yield* f.commit("shared.txt", "main change\n");
      yield* f.git(["push", "origin", "main"]);
      yield* f.git(["checkout", "a"]);
      yield* f.stacks.update(f.cwd, { includeLatestBase: true }).pipe(Effect.flip);
      expect((yield* f.stacks.inspect(f.cwd)).operation?.branch).toBe("a");
      yield* f.fs.writeFileString(f.path.join(f.cwd, "shared.txt"), "resolved main and layer\n");
      yield* f.git(["add", "shared.txt"]);
      yield* f.git(["-c", "core.editor=true", "rebase", "--continue"]);
      const completedA = yield* f.git(["rev-parse", "a"]);
      const updates: GitWorkflowProgressUpdate[] = [];
      const restarted = yield* make;
      const result = yield* restarted.manage(
        { cwd: f.cwd, action: "continue" },
        [],
        undefined,
        (update) =>
          Effect.sync(() => {
            updates.push(update);
          }),
      );
      expect(result.operation).toBeNull();
      expect(yield* f.git(["rev-parse", "a"])).toBe(completedA);
      expect(yield* f.git(["rev-parse", "c"])).not.toBe(oldC);
      expect(yield* f.git(["show", "c:shared.txt"])).toBe("resolved main and layer");
      expect(yield* f.git(["branch", "--show-current"])).toBe("a");
      expect(yield* f.git(["ls-remote", "fork"])).toBe(remoteBefore);
      expect(
        updates
          .at(-1)
          ?.steps.filter((step) => step.id.endsWith(":rebase"))
          .every((step) => step.state === "completed"),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["dirty", "worktree", "remote"] as const)(
    "stops before rewriting when %s state is unsafe",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const oldC = yield* f.git(["rev-parse", "c"]);
        if (mode === "dirty") yield* f.fs.writeFileString(f.path.join(f.cwd, "b.txt"), "dirty\n");
        if (mode === "worktree") {
          yield* f.commit("parent.txt", "parent change\n");
          yield* f.git(["worktree", "add", f.path.join(f.root, "other"), "c"]);
        }
        if (mode === "remote")
          yield* f.git([
            `--git-dir=${f.path.join(f.root, "fork")}`,
            "update-ref",
            "refs/heads/c",
            "refs/heads/main",
          ]);
        yield* f.stacks.update(f.cwd).pipe(Effect.flip);
        expect(yield* f.git(["rev-parse", "c"])).toBe(oldC);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps multi-branch publication atomic and resumes a rejected push without rebasing twice",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const oldB = yield* f.remoteHead("fork", "b");
        const oldC = yield* f.remoteHead("fork", "c");
        yield* f.commit("review.txt", "review fix\n");
        const remoteDir = `--git-dir=${f.path.join(f.root, "fork")}`;
        yield* f.git([remoteDir, "config", "receive.denyNonFastForwards", "true"]);
        yield* f.stacks.update(f.cwd, { publishThrough: "c" }).pipe(Effect.flip);
        expect(yield* f.remoteHead("fork", "b")).toBe(oldB);
        expect(yield* f.remoteHead("fork", "c")).toBe(oldC);
        expect((yield* f.stacks.inspect(f.cwd)).operation?.phase).toBe("push");
        const rebased = yield* f.git(["rev-parse", "c"]);
        yield* f.git([remoteDir, "config", "receive.denyNonFastForwards", "false"]);
        yield* f.stacks.manage({ cwd: f.cwd, action: "continue", expectedBranch: "b" });
        expect(yield* f.remoteHead("fork", "c")).toBe(rebased);
        expect(yield* f.git(["rev-parse", "c"])).toBe(rebased);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect(
    "resumes only unfinished post-push hooks after restart without accessing the remote again",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        yield* f.commit("review.txt", "fix\n");
        const calls: string[] = [];
        const afterPush = Effect.fn("test.afterPush")(function* (cwd: string, branch: string) {
          expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe(branch);
          expect(cwd).toBe(f.cwd);
          calls.push(branch);
          if (branch === "c" && calls.filter((name) => name === "c").length === 1)
            return yield* new GitManagerError({ operation: "test", cwd, detail: "Hook failed" });
        });
        yield* f.stacks.update(f.cwd, { publishThrough: "c", afterPush }).pipe(Effect.flip);
        expect(calls).toEqual(["b", "c"]);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toMatchObject({
          phase: "hooks",
          branch: "c",
        });
        expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe("b");
        const top = yield* f.remoteHead("fork", "c");
        yield* f.git(["remote", "set-url", "fork", f.path.join(f.root, "missing")]);
        const restarted = yield* make;
        yield* restarted.manage({ cwd: f.cwd, action: "continue" }, [], afterPush);
        expect(calls).toEqual(["b", "c", "c"]);
        expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe("b");
        expect(yield* f.remoteHead("fork", "c")).toBe(top);
        expect((yield* restarted.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect("fetches a remote fast-forward and propagates it into descendants", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const oldB = yield* f.git(["rev-parse", "b"]);
      const remoteB = yield* f.commit("suggestion.txt", "reviewer suggestion\n");
      yield* f.git(["push", "fork", "b"]);
      yield* f.git(["reset", "--hard", oldB]);
      yield* f.stacks.update(f.cwd);
      expect(yield* f.git(["rev-parse", "b"])).toBe(remoteB);
      expect(yield* f.git(["show", "c:suggestion.txt"])).toBe("reviewer suggestion");
    }).pipe(Effect.scoped),
  );
  it.effect("handles a squash-merged layer whose remote branch was deleted", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      yield* f.git(["checkout", "main"]);
      yield* f.git(["merge", "--squash", "a"]);
      yield* f.git(["commit", "-m", "Squash merged a"]);
      yield* f.git(["push", "origin", "main"]);
      yield* f.git(["push", "fork", "--delete", "a"]);
      yield* f.git(["checkout", "b"]);
      const parents: string[] = [];
      const result = yield* f.stacks.update(f.cwd, {
        publishThrough: "c",
        mergedBranches: ["a"],
        afterPush: Effect.fn("test.parentAfterPush")(function* (_cwd: string, branch: string) {
          parents.push(
            yield* f.git(["config", "--get", `branch.${branch}.t3-merge-base`]).pipe(Effect.orDie),
          );
        }),
      });
      expect(parents).toEqual(["main", "b"]);
      expect(result.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
      expect(yield* f.git(["show", "c:a.txt"])).toBe("a");
      expect(yield* f.git(["rev-list", "--count", "main..c"])).toBe("2");
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    "glab",
    "parents",
    "stale-parent",
    "diverged-parent",
    "ancestry",
    "ancestry-base",
    "ancestry-remote-base",
    "remote-ahead",
    "remote-ahead-no-local",
    "local-ahead",
  ] as const)("discovers branch order from %s without changing its metadata", (source) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (
        source === "remote-ahead" ||
        source === "remote-ahead-no-local" ||
        source === "local-ahead"
      ) {
        const localMain = yield* f.git(["rev-parse", "main"]);
        yield* f.git(
          source === "local-ahead" ? ["checkout", "main"] : ["checkout", "--detach", "origin/main"],
        );
        yield* f.commit("upstream.txt", "one\n");
        yield* f.commit("upstream.txt", "two\n");
        if (source !== "local-ahead") yield* f.git(["push", "origin", "HEAD:main"]);
        yield* f.git(["checkout", "b"]);
        if (source !== "local-ahead") expect(yield* f.git(["rev-parse", "main"])).toBe(localMain);
        if (source === "remote-ahead-no-local") {
          yield* f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
          yield* f.git(["branch", "-D", "main"]);
        }
        expect((yield* f.stacks.inspect(f.cwd)).layers[0]).toMatchObject({
          behindCount: source === "local-ahead" ? 0 : 2,
          needsRestack: source !== "local-ahead",
        });
      }
      if (source === "ancestry-remote-base") {
        yield* f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* f.git(["branch", "-D", "main"]);
      } else if (source === "ancestry-base") {
        yield* f.git(["config", "branch.b.t3-merge-base", "origin/main"]);
        yield* f.git(["config", "branch.c.t3-merge-base", "origin/main"]);
      } else if (
        source === "parents" ||
        source === "stale-parent" ||
        source === "diverged-parent"
      ) {
        yield* f.git(["config", "branch.b.t3-merge-base", "a"]);
        yield* f.git(["config", "branch.c.gh-merge-base", source === "parents" ? "b" : "a"]);
        if (source === "diverged-parent") {
          yield* f.git(["checkout", "a"]);
          yield* f.commit("parent-new.txt", "parent change\n");
          yield* f.git(["checkout", "b"]);
        }
      } else if (source === "glab") {
        const root = f.path.join(f.cwd, ".git", "stacked", "feature");
        yield* f.fs.makeDirectory(root, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(root, "BASE_BRANCH"), "main\n");
        yield* f.fs.writeFileString(
          f.path.join(root, "1.json"),
          '{"sha":"1","branch":"a","prev":"","next":"2"}',
        );
        yield* f.fs.writeFileString(
          f.path.join(root, "2.json"),
          '{"sha":"2","branch":"b","prev":"1","next":"3"}',
        );
        yield* f.fs.writeFileString(
          f.path.join(root, "3.json"),
          '{"sha":"3","branch":"c","prev":"2","next":""}',
        );
      }
      expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual(
        source === "diverged-parent" ? ["a", "b"] : ["a", "b", "c"],
      );
      if (source === "diverged-parent") return;
      yield* f.adopt;
      if (source === "glab")
        expect(
          yield* f.fs.readFileString(f.path.join(f.cwd, ".git", "stacked", "feature", "2.json")),
        ).toBe('{"sha":"2","branch":"b","prev":"1","next":"3"}');
    }).pipe(Effect.scoped),
  );
  it.effect(
    "only includes newer main when requested and removes merged prefix layers without deleting their branches",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        yield* f.git(["checkout", "main"]);
        yield* f.commit("main-extra.txt", "upstream\n");
        yield* f.git(["push", "origin", "main"]);
        yield* f.git(["checkout", "b"]);
        yield* f.stacks.update(f.cwd);
        expect((yield* f.git(["ls-tree", "--name-only", "c"])).includes("main-extra.txt")).toBe(
          false,
        );
        expect((yield* f.stacks.inspect(f.cwd)).layers[0]).toMatchObject({
          needsRestack: true,
          behindCount: 1,
        });
        yield* f.stacks.update(f.cwd, { includeLatestBase: true });
        expect((yield* f.stacks.inspect(f.cwd)).layers[0]).toMatchObject({
          needsRestack: false,
          behindCount: 0,
        });
        expect(yield* f.git(["show", "c:main-extra.txt"])).toBe("upstream");
        const result = yield* f.stacks.update(f.cwd, { mergedBranches: ["a"] });
        expect(result.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
        expect(result.layers[0]?.parent).toBe("main");
        expect(yield* f.git(["rev-parse", "a"])).not.toBe("");
        yield* f.stacks.manage({ cwd: f.cwd, action: "untrack" });
        expect((yield* f.stacks.inspect(f.cwd)).managed).toBe(false);
      }).pipe(Effect.scoped),
  );
});
