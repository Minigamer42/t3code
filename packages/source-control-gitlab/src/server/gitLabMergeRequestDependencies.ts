import {
  PositiveInt,
  SourceControlProviderError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitLabCli from "./GitLabCli.ts";
import { definition } from "../shared/definition.ts";

const Block = Schema.Struct({
  id: Schema.Number,
  blocking_merge_request: Schema.optional(Schema.NullOr(Schema.Struct({ web_url: Schema.String }))),
});
const decodeMergeRequestId = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: PositiveInt })),
);
const decodeBlock = Schema.decodeUnknownEffect(Schema.fromJsonString(Block));
const decodeBlocks = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Block)));
const normalize = (block: typeof Block.Type) => ({
  id: String(block.id),
  url: block.blocking_merge_request?.web_url ?? null,
});

export const make = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;
  const reference = Effect.fn("GitLabDependencies.reference")(function* (
    cwd: string,
    value: string,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: (cause) =>
        new SourceControlProviderError({
          provider: SourceControlProviderKind.make("gitlab"),
          cwd,
          operation: "mergeRequestDependencies",
          detail: "A merge request URL is invalid.",
          cause,
        }),
    });
    const parsed = definition.parseChangeRequestUrl(url);
    if (!parsed || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return yield* new SourceControlProviderError({
        provider: SourceControlProviderKind.make("gitlab"),
        cwd,
        operation: "mergeRequestDependencies",
        detail: "A GitLab merge request URL is required.",
      });
    return { host: url.host, repository: parsed.repository, number: parsed.number };
  });
  const request = Effect.fn("GitLabDependencies.request")(function* (
    cwd: string,
    value: string,
    method: string,
    suffix = "",
    fields: readonly string[] = [],
  ) {
    const ref = yield* reference(cwd, value);
    return yield* cli.execute({
      cwd,
      args: [
        "api",
        "--hostname",
        ref.host,
        "--method",
        method,
        `projects/${encodeURIComponent(ref.repository)}/merge_requests/${ref.number}/blocks${suffix}`,
        ...fields,
      ],
    });
  });
  const operations: NonNullable<
    SourceControlProvider.SourceControlProvider["Service"]["changeRequestDependencies"]
  > = {
    list: Effect.fn("GitLabDependencies.list")(function* (input) {
      const output = yield* request(input.cwd, input.reference, "GET", "?per_page=100").pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "mergeRequestDependencies",
              detail:
                "Could not read merge request dependencies. Check GitLab support and permissions.",
              cause,
            }),
        ),
      );
      return yield* decodeBlocks(output.stdout).pipe(
        Effect.map((blocks) => blocks.map(normalize)),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "mergeRequestDependencies",
              detail: "GitLab returned invalid merge request dependencies.",
              cause,
            }),
        ),
      );
    }),
    add: Effect.fn("GitLabDependencies.add")(function* (input) {
      const target = yield* reference(input.cwd, input.reference);
      const parent = yield* reference(input.cwd, input.blockingReference);
      if (target.host.toLowerCase() !== parent.host.toLowerCase())
        return yield* new SourceControlProviderError({
          provider: SourceControlProviderKind.make("gitlab"),
          cwd: input.cwd,
          operation: "mergeRequestDependencies",
          detail: "Merge request dependencies must be on the same GitLab host.",
        });
      const blocking = yield* cli
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            parent.host,
            "--method",
            "GET",
            `projects/${encodeURIComponent(parent.repository)}/merge_requests/${parent.number}`,
          ],
        })
        .pipe(
          Effect.flatMap((result) => decodeMergeRequestId(result.stdout)),
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("gitlab"),
                cwd: input.cwd,
                operation: "mergeRequestDependencies",
                detail: "Could not resolve the blocking merge request.",
                cause,
              }),
          ),
        );
      const output = yield* request(input.cwd, input.reference, "POST", "", [
        "--field",
        `blocking_merge_request_id=${blocking.id}`,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "mergeRequestDependencies",
              detail:
                "Could not add a merge request dependency. Check GitLab support and permissions.",
              cause,
            }),
        ),
      );
      return yield* decodeBlock(output.stdout).pipe(
        Effect.map(normalize),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "mergeRequestDependencies",
              detail: "GitLab returned an invalid merge request dependency.",
              cause,
            }),
        ),
      );
    }),
    remove: Effect.fn("GitLabDependencies.remove")(function* (input) {
      yield* request(input.cwd, input.reference, "DELETE", `/${encodeURIComponent(input.id)}`).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "mergeRequestDependencies",
              detail:
                "Could not remove a merge request dependency. Check GitLab support and permissions.",
              cause,
            }),
        ),
      );
    }),
  };
  return operations;
});
