import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import type * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitLabCli from "./GitLabCli.ts";

const Pipeline = Schema.Struct({
  id: Schema.Number,
  sha: Schema.String,
  status: Schema.String,
  web_url: Schema.String,
});
const Job = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  web_url: Schema.NullOr(Schema.String),
  allow_failure: Schema.Boolean,
});
const decodePipeline = Schema.decodeUnknownEffect(Pipeline);
const decodeJobs = Schema.decodeUnknownEffect(Schema.Array(Job));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const Mr = Schema.Struct({
  iid: Schema.Number,
  sha: Schema.String,
  source_project_id: Schema.Number,
  target_project_id: Schema.Number,
});
const isProviderError = Schema.is(SourceControlProviderError);
export const make = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;
  const request = Effect.fn("GitLabCi.request")(function* (
    input: { cwd: string; host: string; repository: string },
    endpoint: string,
    method = "GET",
  ) {
    return yield* cli
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          "--method",
          method,
          `projects/${encodeURIComponent(input.repository)}/${endpoint}`,
        ],
        maxOutputBytes: 4_000_000,
      })
      .pipe(
        Effect.filterOrElse(
          (result) => !result.stdoutTruncated,
          () =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "ci",
              detail: "GitLab CI response exceeded the output limit; recovery was not attempted.",
            }),
        ),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              cwd: input.cwd,
              operation: "ci",
              detail: "GitLab CI request failed.",
              cause,
            }),
        ),
      );
  });
  const json = Effect.fn("GitLabCi.json")(function* (
    input: { cwd: string; host: string; repository: string },
    endpoint: string,
  ) {
    return yield* request(input, endpoint).pipe(
      Effect.flatMap((reply) => decodeJson(reply.stdout)),
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            cwd: input.cwd,
            operation: "ci",
            detail: "GitLab returned an invalid CI response.",
            cause,
          }),
      ),
    );
  });
  const operations: NonNullable<Provider.SourceControlProvider["Service"]["ci"]> = {
    read: Effect.fn("GitLabCi.read")(
      function* (input) {
        const branch = yield* json(
          input,
          `repository/branches/${encodeURIComponent(input.branch)}`,
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ commit: Schema.Struct({ id: Schema.String }) }),
            ),
          ),
        );
        if (branch.commit.id !== input.sha) return { current: false, pipeline: null };
        const mrs = yield* json(
          input,
          `merge_requests?state=opened&source_branch=${encodeURIComponent(input.branch)}&per_page=100`,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Mr))));
        const candidates = mrs.filter(
          (item) => item.source_project_id === item.target_project_id && item.sha === input.sha,
        );
        if (candidates.length > 1)
          return yield* new SourceControlProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            cwd: input.cwd,
            operation: "ci",
            detail: "Multiple merge requests match this push; CI tracking cannot select one.",
          });
        const mr = candidates[0];
        let raw: unknown;
        if (mr) {
          const detail = yield* json(input, `merge_requests/${mr.iid}`).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ head_pipeline: Schema.NullOr(Pipeline) })),
            ),
          );
          raw = detail.head_pipeline;
        } else {
          const pipelines = yield* json(
            input,
            `pipelines?ref=${encodeURIComponent(input.branch)}&sha=${input.sha}&per_page=1`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Pipeline))));
          raw = pipelines[0] ?? null;
        }
        if (raw === null) return { current: true, pipeline: null };
        const pipeline = yield* decodePipeline(raw);
        if (pipeline.sha !== input.sha) {
          const commit = yield* json(input, `repository/commits/${pipeline.sha}`).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ parent_ids: Schema.Array(Schema.String) }),
              ),
            ),
          );
          if (!commit.parent_ids.includes(input.sha)) return { current: true, pipeline: null };
        }
        const jobs: (typeof Job.Type)[] = [];
        for (let page = 1; ; page++) {
          const batch = yield* json(
            input,
            `pipelines/${pipeline.id}/jobs?include_retried=false&per_page=100&page=${page}`,
          ).pipe(Effect.flatMap(decodeJobs));
          jobs.push(...batch);
          if (batch.length < 100) break;
        }
        return {
          current: true,
          pipeline: {
            id: String(pipeline.id),
            sha: pipeline.sha,
            status: pipeline.status,
            url: pipeline.web_url,
            jobs: jobs.map((job) => ({
              id: String(job.id),
              name: job.name,
              status: job.status,
              url: job.web_url,
              allowFailure: job.allow_failure,
            })),
          },
        };
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderError(cause)
              ? cause
              : new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("gitlab"),
                  cwd: input.cwd,
                  operation: "ci",
                  detail: "GitLab returned invalid pipeline data.",
                  cause,
                }),
          ),
        ),
    ),
    trace: Effect.fn("GitLabCi.trace")(function* (input) {
      return (yield* request(input, `jobs/${encodeURIComponent(input.jobId)}/trace`)).stdout;
    }),
    run: Effect.fn("GitLabCi.run")(function* (input) {
      yield* request(
        input,
        `jobs/${encodeURIComponent(input.jobId)}/${input.action === "play-job" ? "play" : "retry"}`,
        "POST",
      );
    }),
  };
  return operations;
});
