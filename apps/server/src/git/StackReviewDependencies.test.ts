import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type GitStackStatusResult,
  type GitWorkflowProgressUpdate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { SourceControlProviderError } from "@t3tools/contracts";
import * as Providers from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as StackReviewDependencies from "./StackReviewDependencies.ts";

const url = (id: string) => `https://gitlab.example/acme/app/-/merge_requests/${id}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mr-dependencies-" });
  const edges = new Map<string, { id: string; url: string | null; state?: "open" | "merged" }[]>();
  const changes: string[] = [];
  let sequence = 100;
  let failAdd = false;
  const api = {
    list: ({ reference }: { reference: string }) => Effect.succeed(edges.get(reference) ?? []),
    add: ({ reference, blockingReference }: { reference: string; blockingReference: string }) =>
      Effect.gen(function* () {
        if (failAdd)
          return yield* new SourceControlProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            cwd,
            operation: "test",
            detail: "Add failed",
          });
        const edge = { id: String(sequence++), url: blockingReference };
        edges.set(reference, [...(edges.get(reference) ?? []), edge]);
        changes.push(`add:${reference}->${blockingReference}`);
        return edge;
      }),
    remove: ({ reference, id }: { reference: string; id: string }) =>
      Effect.sync(() => {
        edges.set(
          reference,
          (edges.get(reference) ?? []).filter((edge) => edge.id !== id),
        );
        changes.push(`remove:${reference}:${id}`);
      }),
  };
  const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
    Effect.provide(
      Layer.mock(SourceControlProvider.SourceControlProvider)({
        kind: SourceControlProviderKind.make("gitlab"),
        changeRequestDependencies: api,
      }),
    ),
  );
  const make = StackReviewDependencies.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Providers.SourceControlProviderRegistry)({
          resolve: () => Effect.succeed(provider),
          resolveLink: () => undefined,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: () =>
            Effect.succeed({
              stdout: cwd,
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );
  const stack = (branches: readonly string[], missing?: string) =>
    ({
      base: "main",
      baseIsDefault: true,
      layers: branches.map((branch, index) => ({
        branch,
        parent: branches[index - 1] ?? "main",
        headSha: "a".repeat(40),
        needsRestack: false,
        hasChanges: false,
        current: index === branches.length - 1,
        worktreePath: null,
        pullRequest:
          branch === missing
            ? null
            : { number: branch.charCodeAt(0), url: url(branch), state: "open" as const },
      })),
    }) satisfies Pick<GitStackStatusResult, "base" | "baseIsDefault" | "layers">;
  return {
    cwd,
    edges,
    changes,
    stack,
    make,
    allowAdds: () => {
      failAdd = false;
    },
    failAdds: () => {
      failAdd = true;
    },
  };
});
it.layer(NodeServices.layer)("stack MR dependencies", (it) => {
  it.effect("retains merged dependencies when their layers are kept, removed, or redundant", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* f.make;
      yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) });
      const merged = { ...f.edges.get(url("c"))![0]!, state: "merged" as const };
      f.edges.set(url("c"), [merged]);
      const stack = f.stack(["a", "b", "c"]);
      yield* service.sync({
        cwd: f.cwd,
        stack: {
          ...stack,
          layers: stack.layers.map((layer) =>
            layer.branch === "b"
              ? { ...layer, pullRequest: { ...layer.pullRequest!, state: "merged" as const } }
              : layer,
          ),
        },
      });
      expect(f.edges.get(url("c"))).toContainEqual(merged);
      yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "c"]) });
      expect(f.edges.get(url("c"))).toContainEqual(merged);
      const manual = { id: "merged-manual", url: url("a"), state: "merged" as const };
      f.edges.set(url("c"), [manual]);
      yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) });
      expect(f.edges.get(url("c"))).toContainEqual(manual);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "inserts an intermediate layer while preserving unrelated and hidden manual blockers",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.edges.set(url("c"), [
          { id: "manual-a", url: url("a") },
          { id: "manual-x", url: url("x") },
          { id: "hidden", url: null },
        ]);
        const service = yield* f.make;
        const progress: GitWorkflowProgressUpdate[] = [];
        const input = {
          cwd: f.cwd,
          stack: f.stack(["a", "b", "c"]),
          report: (update: GitWorkflowProgressUpdate) =>
            Effect.sync(() => {
              progress.push(update);
            }),
        };
        yield* service.sync(input);
        expect(progress.at(-1)?.steps).toEqual(
          ["a", "b", "c"].map((branch) => ({
            id: `${branch}:dependencies`,
            group: branch,
            label: "MR dependencies",
            state: "completed",
          })),
        );
        expect(progress[0]?.steps.every((step) => step.state === "running")).toBe(true);
        expect(progress.at(-2)?.steps.at(-1)?.state).toBe("running");
        expect(f.edges.get(url("b"))?.map((edge) => edge.url)).toEqual([url("a")]);
        expect(f.edges.get(url("c"))?.map((edge) => edge.url)).toEqual([url("x"), null, url("b")]);
        expect(f.changes.at(-1)).toBe(`remove:${url("c")}:manual-a`);
        f.changes.length = 0;
        yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) });
        expect(f.changes).toEqual([]);
        f.failAdds();
        yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["b", "c"]) }).pipe(Effect.flip);
        expect(f.edges.get(url("b"))?.map((edge) => edge.url)).toContain(url("a"));
        f.allowAdds();
        yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["b", "c"]) });
        expect(f.edges.get(url("c"))?.map((edge) => edge.url)).toContain(url("a"));
        f.edges.set(
          url("c"),
          f.edges.get(url("c"))!.filter((edge) => edge.url !== url("a")),
        );
        yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["b", "c"]) });
        expect(f.edges.get(url("c"))?.map((edge) => edge.url)).not.toContain(url("a"));
      }).pipe(Effect.scoped),
  );
  it.effect("updates owned edges after restart but preserves a manually recreated dependency", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) });
      yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["a", "c"]) });
      expect(f.edges.get(url("c"))?.map((edge) => edge.url)).toEqual([url("a")]);
      yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) });
      f.edges.set(url("c"), [{ id: "manual-recreated", url: url("b") }]);
      yield* (yield* f.make).sync({ cwd: f.cwd, stack: f.stack(["a", "c"]) });
      expect(f.edges.get(url("c"))?.map((edge) => edge.url)).toEqual([url("b"), url("a")]);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects a manual cycle before changing any dependencies", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.edges.set(url("a"), [{ id: "manual", url: url("c") }]);
      const failed = yield* (yield* f.make)
        .sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) })
        .pipe(Effect.flip);
      expect(failed.message).toContain("cycle");
      expect(f.changes).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "retains original blockers if adding their replacement fails or the parent has no MR",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.edges.set(url("c"), [{ id: "manual-a", url: url("a") }]);
        const service = yield* f.make;
        yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"], "b") });
        expect(f.changes).toEqual([]);
        f.failAdds();
        yield* service.sync({ cwd: f.cwd, stack: f.stack(["a", "b", "c"]) }).pipe(Effect.flip);
        expect(f.edges.get(url("c"))).toEqual([{ id: "manual-a", url: url("a") }]);
      }).pipe(Effect.scoped),
  );
});
