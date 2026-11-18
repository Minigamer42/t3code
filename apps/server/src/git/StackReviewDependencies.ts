import { GitManagerError, type GitStackStatusResult } from "@t3tools/contracts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Providers from "../sourceControl/SourceControlProviderRegistry.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as WorkflowProgress from "./WorkflowProgress.ts";

const Ownership = Schema.Array(
  Schema.Struct({ child: Schema.String, parent: Schema.String, id: Schema.String }),
);
const State = Schema.Struct({
  owned: Ownership,
  required: Schema.Array(
    Schema.Struct({
      child: Schema.String,
      parent: Schema.String,
      directId: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeOwnership = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([State, Ownership])),
);
const encodeOwnership = Schema.encodeEffect(Schema.fromJsonString(State));
const isManagerError = Schema.is(GitManagerError);
type Edge = Effect.Success<
  ReturnType<
    NonNullable<
      SourceControlProvider.SourceControlProvider["Service"]["changeRequestDependencies"]
    >["list"]
  >
>[number];
const keyOf = (url: string) => {
  const ref = sourceControlDefinitions.parseChangeRequestUrl(url)?.link;
  return ref ? threadPullRequestKeyOf({ ...ref, url }) : url;
};
const reachable = (
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  start: string,
  target: string,
) => {
  const queue = [start];
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...(graph.get(node) ?? []));
  }
  return false;
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const sync = Effect.fn("StackReviewDependencies.sync")(
    function* (input: {
      readonly cwd: string;
      readonly stack: Pick<GitStackStatusResult, "base" | "baseIsDefault" | "layers">;
      readonly baseReview?: GitStackStatusResult["layers"][number]["pullRequest"];
      readonly report?: WorkflowProgress.ProgressReporter;
    }) {
      const { cwd, stack } = input;
      const provider = yield* providers.resolve({ cwd });
      const api = provider.changeRequestDependencies;
      if (!api) return;
      const common = (yield* git.execute({
        cwd,
        operation: "StackReviewDependencies.directory",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      })).stdout.trim();
      const filename = path.join(common, "t3-stack-review-dependencies.json");
      yield* withWorkspaceLease(
        filename,
        Effect.gen(function* () {
          const stored = (yield* fs.exists(filename))
            ? yield* fs.readFileString(filename).pipe(Effect.flatMap(decodeOwnership))
            : { owned: [], required: [] };
          let ownership = "owned" in stored ? stored.owned : stored;
          let required = "required" in stored ? stored.required : [];
          const remember = (child: string, parent: string, directId: string | null) => {
            required = [
              ...required.filter(
                (item) =>
                  keyOf(item.child) !== keyOf(child) || keyOf(item.parent) !== keyOf(parent),
              ),
              { child, parent, directId },
            ];
          };
          const persist = Effect.fn("StackReviewDependencies.persist")(function* () {
            const data = yield* encodeOwnership({ owned: ownership, required });
            yield* fs.writeFileString(`${filename}.tmp`, data, { mode: 0o600 });
            yield* fs.rename(`${filename}.tmp`, filename);
          });
          const byBranch = new Map(stack.layers.map((layer) => [layer.branch, layer.pullRequest]));
          if (input.baseReview) byBranch.set(stack.base, input.baseReview);
          const merged = new Set(
            [...byBranch.values()].flatMap((review) =>
              review?.state === "merged" ? [keyOf(review.url)] : [],
            ),
          );
          const isMerged = (edge: Edge) =>
            edge.state === "merged" || (edge.url !== null && merged.has(keyOf(edge.url)));
          const desired = new Map<string, string | null>();
          for (const layer of stack.layers) {
            if (layer.pullRequest?.state !== "open") continue;
            const parent = byBranch.get(layer.parent);
            if (byBranch.has(layer.parent) && !parent) continue;
            if (!byBranch.has(layer.parent) && !stack.baseIsDefault) continue;
            desired.set(layer.pullRequest.url, parent?.url ?? null);
          }
          if (
            ![...desired.values()].some(Boolean) &&
            ![...ownership, ...required].some((item) =>
              [...desired.keys()].some((url) => keyOf(url) === keyOf(item.child)),
            )
          )
            return;
          const branches = new Map(
            stack.layers.flatMap((layer) =>
              layer.pullRequest ? [[layer.pullRequest.url, layer.branch] as const] : [],
            ),
          );
          const progress = WorkflowProgress.reportSteps(
            input.report,
            [...desired.keys()].map((child) => ({
              id: `${branches.get(child)!}:dependencies`,
              group: branches.get(child)!,
              label: "MR dependencies",
              state: "running",
            })),
          );
          yield* progress("Checking MR dependencies...");
          const records = new Map<string, { url: string; edges: readonly Edge[] }>();
          const load = Effect.fn("StackReviewDependencies.load")(function* (
            roots: readonly string[],
          ) {
            let queue = [...roots];
            while (queue.length > 0) {
              const batch = [...new Map(queue.map((url) => [keyOf(url), url])).entries()].filter(
                ([key]) => !records.has(key),
              );
              if (records.size + batch.length > 512)
                return yield* new GitManagerError({
                  cwd,
                  operation: "stackDependencies",
                  detail: "The MR dependency graph is too large to verify safely.",
                });
              const loaded = yield* Effect.forEach(
                batch,
                ([key, url]) =>
                  api
                    .list({ cwd, reference: url })
                    .pipe(Effect.map((edges) => ({ key, url, edges }))),
                { concurrency: 4 },
              );
              for (const record of loaded)
                records.set(record.key, { url: record.url, edges: record.edges });
              queue = loaded.flatMap((record) =>
                record.edges.flatMap((edge) => (edge.url ? [edge.url] : [])),
              );
            }
          });
          const desiredKeys = new Set([...desired.keys()].map(keyOf));
          const roots = [
            ...desired.keys(),
            ...[...desired.values()].filter((url) => url !== null),
            ...required
              .filter((item) => desiredKeys.has(keyOf(item.child)))
              .map((item) => item.parent),
          ];
          yield* load(roots);
          const priorRequiredCount = required.length;
          required = required.filter(
            (item) =>
              !desiredKeys.has(keyOf(item.child)) ||
              item.directId === null ||
              records
                .get(keyOf(item.child))!
                .edges.some(
                  (edge) =>
                    edge.id === item.directId &&
                    (!edge.url || keyOf(edge.url) === keyOf(item.parent)),
                ),
          );
          if (required.length !== priorRequiredCount) yield* persist();
          const graph = () =>
            new Map(
              [...records].map(([key, record]) => [
                key,
                new Set(record.edges.flatMap((edge) => (edge.url ? [keyOf(edge.url)] : []))),
              ]),
            );
          const planned = graph();
          const obsolete: { child: string; edge: Edge }[] = [];
          for (const [child, parent] of desired) {
            const key = keyOf(child);
            for (const edge of records.get(key)!.edges) {
              if (!edge.url || isMerged(edge) || (parent && keyOf(edge.url) === keyOf(parent)))
                continue;
              if (
                ownership.some(
                  (item) =>
                    keyOf(item.child) === key &&
                    item.id === edge.id &&
                    keyOf(item.parent) === keyOf(edge.url!),
                )
              ) {
                obsolete.push({ child, edge });
                planned.get(key)!.delete(keyOf(edge.url));
              }
            }
            if (parent) planned.get(key)!.add(keyOf(parent));
          }
          const structural = new Map([...planned].map(([key, parents]) => [key, new Set(parents)]));
          for (const item of required)
            if (desiredKeys.has(keyOf(item.child)))
              planned.get(keyOf(item.child))!.add(keyOf(item.parent));
          for (const [child, parents] of planned)
            for (const parent of parents)
              if (reachable(planned, parent, child))
                return yield* new GitManagerError({
                  cwd,
                  operation: "stackDependencies",
                  detail:
                    "The stack order conflicts with existing manual MR dependencies and would create a cycle. Dependencies were left unchanged.",
                });
          const remove = Effect.fn("StackReviewDependencies.remove")(function* (
            child: string,
            edge: Edge,
          ) {
            if (isMerged(edge)) return;
            yield* api.remove({ cwd, reference: child, id: edge.id });
            const record = records.get(keyOf(child))!;
            records.set(keyOf(child), {
              ...record,
              edges: record.edges.filter((item) => item.id !== edge.id),
            });
            ownership = ownership.filter(
              (item) => !(keyOf(item.child) === keyOf(child) && item.id === edge.id),
            );
            yield* persist();
          });
          for (const item of required) {
            if (
              !desiredKeys.has(keyOf(item.child)) ||
              reachable(structural, keyOf(item.child), keyOf(item.parent))
            )
              continue;
            const record = records.get(keyOf(item.child))!;
            if (record.edges.some((edge) => edge.url && keyOf(edge.url) === keyOf(item.parent)))
              continue;
            if (reachable(graph(), keyOf(item.parent), keyOf(item.child)))
              return yield* new GitManagerError({
                cwd,
                operation: "stackDependencies",
                detail:
                  "Existing MR dependencies prevent safely preserving a manual blocker. Resolve the conflicting dependency before updating this stack.",
              });
            const edge = yield* api.add({
              cwd,
              reference: item.child,
              blockingReference: item.parent,
            });
            records.set(keyOf(item.child), { ...record, edges: [...record.edges, edge] });
            remember(item.child, item.parent, edge.id);
            yield* persist();
          }
          for (const { child, edge } of obsolete) {
            const parent = desired.get(child);
            if (!parent || !reachable(planned, keyOf(parent), keyOf(edge.url!)))
              yield* remove(child, edge);
          }
          for (const [child, parent] of desired) {
            if (
              !parent ||
              records
                .get(keyOf(child))!
                .edges.some((edge) => edge.url && keyOf(edge.url) === keyOf(parent))
            )
              continue;
            const edge = yield* api.add({ cwd, reference: child, blockingReference: parent });
            ownership = [
              ...ownership.filter(
                (item) => !(keyOf(item.child) === keyOf(child) && item.id === edge.id),
              ),
              { child, parent, id: edge.id },
            ];
            yield* persist();
          }
          records.clear();
          yield* load(roots);
          for (const item of required) {
            if (!desiredKeys.has(keyOf(item.child))) continue;
            const record = records.get(keyOf(item.child))!;
            const direct = record.edges.find(
              (edge) => edge.url && keyOf(edge.url) === keyOf(item.parent),
            );
            if (direct) remember(item.child, item.parent, direct.id);
            else if (!reachable(graph(), keyOf(item.child), keyOf(item.parent))) {
              const edge = yield* api.add({
                cwd,
                reference: item.child,
                blockingReference: item.parent,
              });
              records.set(keyOf(item.child), { ...record, edges: [...record.edges, edge] });
              remember(item.child, item.parent, edge.id);
            } else remember(item.child, item.parent, null);
            yield* persist();
          }
          for (const [child, parent] of desired) {
            for (const edge of records.get(keyOf(child))!.edges) {
              if (
                parent &&
                edge.url &&
                !isMerged(edge) &&
                keyOf(edge.url) !== keyOf(parent) &&
                reachable(graph(), keyOf(parent), keyOf(edge.url))
              ) {
                if (
                  !ownership.some(
                    (item) => keyOf(item.child) === keyOf(child) && item.id === edge.id,
                  )
                ) {
                  remember(child, edge.url, null);
                  yield* persist();
                }
                yield* remove(child, edge);
              }
            }
            yield* progress(`MR dependencies updated for ${branches.get(child)!}`, (steps) =>
              steps.map((step) =>
                step.group === branches.get(child) ? { ...step, state: "completed" } : step,
              ),
            );
          }
        }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : new GitManagerError({
                cwd: input.cwd,
                operation: "stackDependencies",
                detail:
                  "MR dependency synchronization failed. Check GitLab support and permissions, then retry Update stack.",
                cause,
              }),
        ),
      ),
  );
  return { sync };
});
